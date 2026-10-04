import { runCliHarness } from "@claudexor/core";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { HarnessEvent } from "@claudexor/schema";
import { AuthCapabilityVerifier } from "../../core/src/auth-capability-verifier.js";
import { createClaudeAdapter } from "./index.js";

it("verifies default-store Claude auth after the native adapter's effort preparation receipt", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-authcap-")));
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", root);
  vi.stubEnv("CLAUDEXOR_CLAUDE_NATIVE_DIR", undefined);
  const events: HarnessEvent[] = [];
  const probeAuthStatus = vi.fn(async () => ({
    loggedIn: true,
    authed: true,
    authMethod: "claude.ai",
    probeError: null,
  }));
  const probeEffortLevels = vi.fn(async () => ({ levels: ["low", "high"], live: true }));
  const transport = vi.fn();
  const unexpectedCredential = vi.fn(() => {
    throw new Error("capability smoke must use the injected default native-session probe");
  });
  try {
    const adapter = createClaudeAdapter({
      probeAuthStatus,
      probeEffortLevels,
      probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "fixture" }),
      anthropicApiKey: unexpectedCredential,
      claudeOAuthToken: unexpectedCredential,
      resolveProfileSecret: unexpectedCredential,
      runCliHarness: (options) => {
        transport(options);
        expect(options.spec).toMatchObject({
          auth_preference: "subscription",
          credential_profile: null,
          effort_hint: null,
          access: "readonly",
          env_inheritance: "clean",
          evidence_policy: "stream_only",
        });
        expect(options.env?.CLAUDE_CONFIG_DIR).toBe(join(root, "native", "claude", "default"));
        expect(options.args).not.toContain("--effort");
        const challenge = /^Return exactly (\S+) and no other text\./.exec(
          options.spec.prompt,
        )?.[1];
        if (!challenge) throw new Error("missing capability challenge");
        // Keep the real CLI loop, native parser and credential decoration.
        // Only process I/O is substituted; the advisory arrives before init.
        return runCliHarness({
          ...options,
          spawn: async function* (_bin, _args, spawnOptions) {
            spawnOptions?.onSpawn?.({ write() {}, end() {}, closed: Promise.resolve() });
            yield {
              type: "launch_advisory",
              detail: "Using the working fallback; preferred entry is broken",
            };
            for (const frame of [
              { type: "system", subtype: "init", session_id: "native-claude-smoke" },
              {
                type: "result",
                subtype: "success",
                result: challenge,
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            ])
              yield { type: "stdout", line: JSON.stringify(frame) };
            yield { type: "exit", code: 0, signal: null };
          },
        });
      },
    });
    const verifier = new AuthCapabilityVerifier(
      (id) =>
        id === adapter.id
          ? {
              ...adapter,
              async *run(spec) {
                for await (const event of adapter.run(spec)) {
                  events.push(event);
                  yield event;
                }
              },
            }
          : undefined,
      { scratchRoot: join(root, "smokes") },
    );
    const { binding } = verifier.prepare({
      attemptId: "claude-default-store",
      harness: "claude",
      requested: "subscription",
      requiredRoute: "vendor_native",
      requiredSource: "native_session",
    });
    const receipt = await verifier.verify({ binding, startedAt: new Date().toISOString() });

    expect(probeAuthStatus).toHaveBeenCalledTimes(1);
    expect(probeEffortLevels).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(unexpectedCredential).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: "status",
      session_id: "auth-smoke-claude-default-store",
      effort_resolution: {
        requested: null,
        submitted: null,
        parameter: "--effort",
        observed: null,
        observedSource: null,
        resolution: "omitted",
        source: "live_probe",
      },
    });
    expect(events[0]).not.toHaveProperty("text");
    expect(events[1]).toMatchObject({
      type: "started",
      credential_route: "vendor_native",
      credential_source: "native_session",
      payload: { native_session_id: "native-claude-smoke" },
    });
    expect(events[2]).toMatchObject({
      type: "status",
      text: "Using the working fallback; preferred entry is broken",
      payload: { launch_advisory: true },
    });
    expect(events.some((event) => event.type === "message" && event.final === true)).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
    expect(receipt).toMatchObject({
      verification: "passed",
      availability: "available",
      effective: "vendor_native",
      effectiveSource: "native_session",
      selectionReason: "exact_requested_route",
      responseDigest: binding.challengeDigest,
      scratchBeforeDigest: receipt.scratchAfterDigest,
    });
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
