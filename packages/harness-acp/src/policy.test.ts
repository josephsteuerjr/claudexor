import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { CredentialProfile, HarnessRunSpec } from "@claudexor/schema";
import { copilot } from "./entry.js";
import { acpArgs, decidePermission } from "./policy.js";
import { acpChildEnv, acpToken, probeAcpProfile } from "./env.js";

const root = mkdtempSync(join(tmpdir(), "acp-policy-"));
const cwd = join(root, "workspace");
mkdirSync(cwd);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const permission = (kind: string, rawInput: unknown = {}) =>
  ({
    sessionId: "native",
    toolCall: { toolCallId: "t1", kind, rawInput },
    options: [
      { optionId: "always", kind: "allow_always", name: "Always" },
      { optionId: "once", kind: "allow_once", name: "Once" },
    ],
  }) as RequestPermissionRequest;
const selected = { outcome: { outcome: "selected", optionId: "once" } };
const denied = { outcome: { outcome: "cancelled" } };

describe("ACP typed permissions", () => {
  it("refuses a dangling symlink whose new target would be outside cwd", () => {
    symlinkSync(join(root, "not-created"), join(cwd, "dangling"));
    expect(
      decidePermission("workspace_write", cwd, permission("edit", { path: "dangling" })),
    ).toEqual(denied);
    expect(
      decidePermission("workspace_write", cwd, permission("edit", { path: "dangling/new.txt" })),
    ).toEqual(denied);
  });
  it.each(["read", "search"])("readonly admits %s with workspace evidence", (kind) => {
    expect(decidePermission("readonly", cwd, permission(kind, { pattern: "needle" }))).toEqual(
      selected,
    );
    expect(decidePermission("readonly", cwd, permission(kind, { path: "src/a.ts" }))).toEqual(
      selected,
    );
  });
  it.each(["edit", "execute", "fetch", "other"])("readonly refuses %s", (kind) => {
    expect(
      decidePermission("readonly", cwd, permission(kind, { command: "echo hi", path: "src/a.ts" })),
    ).toEqual(denied);
  });
  it("admits workspace edits and session-bound commands", () => {
    expect(
      decidePermission("workspace_write", cwd, permission("edit", { path: "new/a.ts" })),
    ).toEqual(selected);
    expect(
      decidePermission("workspace_write", cwd, permission("execute", { command: "npm test" })),
    ).toEqual(selected);
  });
  it.each([
    permission("edit"),
    permission("edit", { path: "../outside" }),
    permission("read"),
    permission("execute", { command: [] }),
    permission("edit", { paths: [null] }),
    permission("edit", { paths: 42 }),
    permission("fetch", { url: "https://example.com" }),
    permission("edit", []),
  ])("refuses unknown or outside requests", (params) => {
    expect(decidePermission("workspace_write", cwd, params)).toEqual(denied);
  });
  it("resolves an escaping symlink even for a not-yet-created file", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(
      decidePermission("workspace_write", cwd, permission("edit", { path: "link/new.ts" })),
    ).toEqual(denied);
  });
  it("uses only a supplied permission option and never escalates inherit_native", () => {
    expect(decidePermission("full", cwd, permission("execute"))).toEqual({
      outcome: { outcome: "selected", optionId: "always" },
    });
    expect(decidePermission("inherit_native", cwd, permission("edit", { path: "a" }))).toEqual(
      denied,
    );
    const request = permission("edit", { path: "a" });
    request.options = request.options.slice(0, 1);
    expect(decidePermission("workspace_write", cwd, request)).toEqual(denied);
  });
  it("enforces readonly at spawn even if permission callbacks never arrive", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "s",
      task_id: "t",
      intent: "review",
      prompt: "read",
      cwd,
      access: "readonly",
      model_hint: "opaque model",
      effort_hint: "max",
    });
    expect(acpArgs(copilot, spec)).toContain("--available-tools=view,glob,grep");
    expect(acpArgs(copilot, spec).slice(-1)[0]).toBe("--available-tools=view,glob,grep");
    spec.tool_permission_policy.allow = ["view", "bash"];
    expect(acpArgs(copilot, spec)).toContain("--available-tools=view");
    spec.tool_permission_policy.deny = ["view"];
    expect(() => acpArgs(copilot, spec)).toThrow("no available tools");
  });
});

describe("ACP credential and environment isolation", () => {
  const profile = CredentialProfile.parse({
    profile_id: "work",
    harness_id: "copilot",
    display_name: "Work",
    credential_kind: "api_key",
    secret_ref: "copilot:work",
  });
  it("uses only the exact managed secret; presence is not vendor verification", () => {
    expect(acpToken(copilot, profile, (ref) => (ref === "copilot:work" ? "stored" : null))).toBe(
      "stored",
    );
    expect(probeAcpProfile(copilot, profile, () => "stored")).toMatchObject({
      availability: "available",
      verification: "not_run",
    });
    expect(() => acpToken(copilot, profile, () => null)).toThrow("not logged in");
    expect(() => acpToken(copilot, { ...profile, secret_ref: "copilot" }, () => "default")).toThrow(
      "namespaced",
    );
    expect(() => acpToken(copilot, { ...profile, harness_id: "codex" }, () => "wrong")).toThrow(
      "namespaced",
    );
  });
  it("forwards OS/proxy settings, scopes all homes, and excludes host secrets and BYOK", () => {
    const env = acpChildEnv(copilot, cwd, "managed", {
      PATH: "/usr/bin",
      HOME: "/host",
      COPILOT_HOME: "/host/copilot",
      https_proxy: "http://proxy",
      COPILOT_GITHUB_TOKEN: "ambient",
      GH_TOKEN: "host",
      GITHUB_TOKEN: "host",
      OPENAI_API_KEY: "paid",
      COPILOT_PROVIDER_BASE_URL: "https://other",
      NODE_OPTIONS: "--require=host",
      HOST_SERVICE_TOKEN: "host",
      COPILOT_ALLOW_ALL: "true",
      CODEX_THREAD_ID: "parent",
    });
    expect(env["HOME"]).toBe(cwd);
    expect(env["COPILOT_HOME"]).toBe(join(cwd, ".copilot"));
    expect(env["COPILOT_GITHUB_TOKEN"]).toBe("managed");
    expect(env["https_proxy"]).toBe("http://proxy");
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
      "COPILOT_PROVIDER_BASE_URL",
      "NODE_OPTIONS",
      "HOST_SERVICE_TOKEN",
      "COPILOT_ALLOW_ALL",
      "CODEX_THREAD_ID",
    ])
      expect(env[key] ?? null).toBeNull();
  });
});
