/**
 * The CLI-first maintenance primitive against isolated fake prefixes: a temp
 * HOME, a fake runner Node with an embedded npm stub, and a fake spawnSync that
 * answers `--version`, `npm view` and `npm install` without the network. No
 * test touches ~/.claudexor, a real vendor CLI or a credential.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_VENDOR_CLI_VERSION } from "@claudexor/harness-codex";
import type { ParsedArgs } from "./args.js";
import { harnessInstallCommand, localPlatformRefusal } from "./harness-installer.js";
import { compareVendorVersions } from "./harness-install-proof.js";
import { harnessMaintenanceRecipe } from "./harness-install-recipes.js";
import { inspectHarness, runHarnessUpdate } from "./harness-maintenance.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const exe = (path: string, body = "#!/bin/sh\nexit 0\n"): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
};

/** A scratch world: HOME, runner Node with embedded npm, nothing installed. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "cx-maint-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const nodePath = exe(join(root, "runner", "bin", "node"));
  exe(join(root, "runner", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  const managed = join(home, ".claudexor", "node");
  /** Lay down a managed npm copy of codex at `version`. */
  const installCodex = (version: string): string => {
    const pkg = join(managed, "lib", "node_modules", "@openai", "codex");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version }));
    const binary = exe(join(pkg, "bin", "codex.js"), `#!/bin/sh\necho codex-cli ${version}\n`);
    mkdirSync(join(managed, "bin"), { recursive: true });
    rmSync(join(managed, "bin", "codex"), { force: true });
    exe(join(managed, "bin", "codex"), `#!/bin/sh\nexec ${binary} "$@"\n`);
    return version;
  };
  const sourceEnv = { HOME: home, PATH: "/usr/bin:/bin" };
  return { root, home, nodePath, managed, installCodex, sourceEnv };
}

/** spawnSync fake: `--version` reads the launcher script's echo, npm view
 * answers `latest`, npm install lays down the requested managed version. */
function fakeSpawn(w: ReturnType<typeof world>, latest = "99.1.0", installOk = true) {
  const calls: string[][] = [];
  const spawn = vi.fn((binary: string, argv: readonly string[]) => {
    calls.push([binary, ...argv]);
    if (argv.includes("--version")) {
      const target = binary.endsWith("node") ? argv[0]! : binary;
      const body = readFileSync(target, "utf8");
      const nested = /exec (\S+)/.exec(body)?.[1];
      const text = nested ? readFileSync(nested, "utf8") : body;
      const answer = /echo (.*)/.exec(text)?.[1] ?? "";
      return { status: 0, stdout: `${answer}\n`, stderr: "" } as never;
    }
    if (argv.includes("view")) return { status: 0, stdout: `"${latest}"\n`, stderr: "" } as never;
    if (argv.includes("install")) {
      if (!installOk) return { status: 1, signal: null } as never;
      const spec = String(argv.at(-1));
      w.installCodex(spec.slice(spec.lastIndexOf("@") + 1));
      return { status: 0 } as never;
    }
    return { status: 0, stdout: "", stderr: "" } as never;
  });
  return { spawn, calls };
}

const opts = (w: ReturnType<typeof world>, spawn: unknown) => ({
  home: w.home,
  nodePath: w.nodePath,
  sourceEnv: w.sourceEnv,
  spawn: spawn as never,
  platform: "darwin" as const,
  arch: "arm64",
  lock: false,
});

const args = (positional: string[], flags: ParsedArgs["flags"] = {}): ParsedArgs => ({
  _: positional,
  flags,
});

describe("harness maintenance primitive", () => {
  it("orders exact versions by SemVer precedence", () => {
    expect(compareVendorVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVendorVersions("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
    expect(compareVendorVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBeLessThan(0);
    expect(compareVendorVersions("2.0.0+build.1", "2.0.0")).toBe(0);
  });

  it("legacy ensure keeps a runnable NEWER managed copy and its exact legacy keys", () => {
    const w = world();
    w.installCodex("99.0.0");
    const { spawn, calls } = fakeSpawn(w);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = harnessInstallCommand(
      args(["harness", "install", "codex"], { target: "local", yes: true }),
      true,
      { ...opts(w, spawn), exists: () => true },
    );
    expect(code).toBe(0);
    expect(calls.some((call) => call.includes("install"))).toBe(false);
    const receipt = JSON.parse(out.join("")) as Record<string, unknown>;
    expect(receipt.installedVersion).toBe("99.0.0");
    expect(receipt.pinnedVersion).toBe(CODEX_VENDOR_CLI_VERSION);
    // Old strict parsers keep running: no maintenance-only key leaks into Connect.
    expect(Object.keys(receipt).sort()).toEqual(
      [
        "ok",
        "dryRun",
        "exitCode",
        "installedBinary",
        "installedVersion",
        "harness",
        "target",
        "command",
        "installLocation",
        "pinnedVersion",
        "verification",
      ].sort(),
    );
  });

  it("legacy ensure still upgrades an OLDER managed copy to the pin", () => {
    const w = world();
    w.installCodex("0.0.1");
    const { spawn, calls } = fakeSpawn(w);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = harnessInstallCommand(
      args(["harness", "install", "codex"], { target: "local", yes: true }),
      true,
      { ...opts(w, spawn), exists: () => true },
    );
    expect(code).toBe(0);
    expect(calls.find((call) => call.includes("install"))?.at(-1)).toBe(
      `@openai/codex@${CODEX_VENDOR_CLI_VERSION}`,
    );
  });

  it("an exact target installs that version and records the proved previous one", () => {
    const w = world();
    w.installCodex("1.0.0");
    const { spawn, calls } = fakeSpawn(w);
    const receipt = runHarnessUpdate("codex", "1.2.3", opts(w, spawn));
    expect(receipt).toMatchObject({
      ok: true,
      mutation: "applied",
      requestedVersion: "1.2.3",
      resolvedVersion: "1.2.3",
      previousVersion: "1.0.0",
      before: { version: "1.0.0", selection: "managed", proved: true },
      after: { version: "1.2.3", selected: true, proved: true },
    });
    expect(calls.filter((call) => call.includes("install"))).toHaveLength(1);
    expect(calls.find((call) => call.includes("install"))?.at(-1)).toBe("@openai/codex@1.2.3");
  });

  it("latest is resolved ONCE to an exact version before the install", () => {
    const w = world();
    w.installCodex("1.0.0");
    const { spawn, calls } = fakeSpawn(w, "7.7.7");
    const receipt = runHarnessUpdate("codex", "latest", opts(w, spawn));
    expect(calls.filter((call) => call.includes("view"))).toHaveLength(1);
    expect(calls.find((call) => call.includes("install"))?.at(-1)).toBe("@openai/codex@7.7.7");
    expect(receipt).toMatchObject({
      ok: true,
      requestedVersion: "latest",
      resolvedVersion: "7.7.7",
    });
  });

  it("a failed install keeps the proved before fact and reports an unknown effect", () => {
    const w = world();
    w.installCodex("1.0.0");
    const { spawn } = fakeSpawn(w, "7.7.7", false);
    const receipt = runHarnessUpdate("codex", "2.0.0", opts(w, spawn));
    expect(receipt).toMatchObject({
      ok: false,
      mutation: "unknown",
      previousVersion: "1.0.0",
      before: { version: "1.0.0", proved: true },
    });
  });

  it("an explicit override is not falsely activated: no install, typed remedy", () => {
    const w = world();
    w.installCodex("1.0.0");
    const custom = exe(join(w.root, "custom", "codex"), "#!/bin/sh\necho codex-cli 5.0.0\n");
    const { spawn, calls } = fakeSpawn(w);
    const env = { ...w.sourceEnv, CLAUDEXOR_CODEX_BIN: custom };
    const row = inspectHarness("codex", { ...opts(w, spawn), sourceEnv: env });
    expect(row).toMatchObject({
      maintainable: false,
      targets: [],
      selection: {
        kind: "override",
        binary: custom,
        version: "5.0.0",
        overrideEnv: "CLAUDEXOR_CODEX_BIN",
      },
      installed: { version: "1.0.0", proved: true },
    });
    const receipt = runHarnessUpdate("codex", "2.0.0", { ...opts(w, spawn), sourceEnv: env });
    expect(receipt).toMatchObject({
      ok: false,
      code: "harness_not_maintainable",
      mutation: "none",
    });
    expect(calls.some((call) => call.includes("install"))).toBe(false);
  });

  it("a selected copy outside the managed prefix is not silently taken over", () => {
    const w = world();
    exe(join(w.home, ".local", "bin", "codex"), "#!/bin/sh\necho codex-cli 0.153.3\n");
    const { spawn } = fakeSpawn(w);
    const row = inspectHarness("codex", opts(w, spawn));
    expect(row).toMatchObject({
      maintainable: false,
      selection: { kind: "path", version: "0.153.3" },
      installed: { version: null, proved: false },
    });
    expect(row.remedy).toContain("outside Claudexor's managed prefix");
  });

  it("inspection never installs or logs in; --latest is one registry read", () => {
    const w = world();
    w.installCodex("1.0.0");
    const { spawn, calls } = fakeSpawn(w, "3.0.0");
    const row = inspectHarness("codex", { ...opts(w, spawn), latest: true });
    expect(row.available?.version).toBe("3.0.0");
    expect(row.releaseTested.version).toBe(CODEX_VENDOR_CLI_VERSION);
    expect(row.selection.version).toBe("1.0.0");
    expect(calls.some((call) => call.includes("install") || call.includes("login"))).toBe(false);
    expect(calls.filter((call) => call.includes("view"))).toHaveLength(1);
  });

  it("Windows: Codex and Claude keep their supported npm entrypoint; others keep their facts", () => {
    for (const harness of ["codex", "claude"] as const) {
      expect(localPlatformRefusal(harness, "win32", "x64")).toBeNull();
      expect(localPlatformRefusal(harness, "win32", "arm64")).toBeNull();
      expect(harnessMaintenanceRecipe(harness, "win32").mechanism).toBe("managed_npm");
    }
    expect(localPlatformRefusal("copilot", "win32", "x64")?.code).toBe("unsupported_platform");
    expect(localPlatformRefusal("opencode", "win32", "x64")?.code).toBe("unsupported_platform");
    expect(harnessMaintenanceRecipe("cursor", "win32")).toMatchObject({
      mechanism: "vendor_script",
      targets: [],
    });
    expect(harnessMaintenanceRecipe("agy", "darwin").targets).toEqual(["latest"]);
  });
});

describe("vendor updater (cursor/agy): latest only, canonical HOME launcher", () => {
  /** A Cursor-shaped install: the canonical launcher reads a version file that
   * its own `update` rewrites, so the re-probe observes the real effect. */
  function cursorWorld(updateTo: string | null) {
    const w = world();
    const state = join(w.root, "cursor-version");
    writeFileSync(state, "2026.08.11-e8db854");
    const launcher = exe(
      join(w.home, ".local", "bin", "cursor-agent"),
      `#!/bin/sh\ncat ${state}\n`,
    );
    const calls: string[][] = [];
    const spawn = vi.fn((binary: string, argv: readonly string[]) => {
      calls.push([binary, ...argv]);
      if (argv.includes("--version"))
        return { status: 0, stdout: `${readFileSync(state, "utf8")}\n`, stderr: "" } as never;
      if (argv[0] === "update") {
        if (updateTo !== null) writeFileSync(state, updateTo);
        return { status: 0 } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });
    return { w, launcher, spawn, calls };
  }

  it("runs the selected launcher's own update and re-probes the new version", () => {
    const { w, launcher, spawn, calls } = cursorWorld("2026.10.01-e373342");
    const receipt = runHarnessUpdate("cursor", undefined, opts(w, spawn));
    expect(calls.find((call) => call.at(-1) === "update")?.[0]).toBe(launcher);
    expect(receipt).toMatchObject({
      ok: true,
      mechanism: "vendor_updater",
      mutation: "applied",
      before: { version: "2026.08.11-e8db854", binary: launcher, selection: "path" },
      after: { version: "2026.10.01-e373342", binary: launcher, selected: true },
    });
    expect(receipt.limitations).toContain("vendor_resolves_latest");
  });

  it("an unchanged version after exit 0 is 'no change observed', never 'updated'", () => {
    const { w, spawn } = cursorWorld(null);
    const receipt = runHarnessUpdate("cursor", undefined, opts(w, spawn));
    expect(receipt).toMatchObject({ ok: true, mutation: "none", resolvedVersion: null });
    expect(receipt.limitations).toContain("no_version_change_observed");
  });

  it("exit zero without a post-update version leaves possible mutation unknown", () => {
    const { w, spawn } = cursorWorld("");
    const receipt = runHarnessUpdate("cursor", undefined, opts(w, spawn));
    expect(receipt).toMatchObject({
      ok: false,
      code: "install_verification_failed",
      mutation: "unknown",
      after: { version: null, proved: false },
    });
  });

  it("declares no latest check, and an explicit check is a typed unsupported problem", () => {
    const { w, spawn, calls } = cursorWorld(null);
    const row = inspectHarness("cursor", { ...opts(w, spawn), latest: true });
    expect(row).toMatchObject({
      maintainable: true,
      canCheckLatest: false,
      targets: ["latest"],
      available: null,
      availableProblem: { code: "latest_check_unsupported", retryable: false },
    });
    expect(calls.some((call) => call.at(-1) === "update" || call.includes("view"))).toBe(false);
    expect(inspectHarness("codex", opts(w, spawn)).canCheckLatest).toBe(true);
  });

  it("refuses an exact version: the vendor resolves latest itself", () => {
    const { w, spawn, calls } = cursorWorld("x");
    const receipt = runHarnessUpdate("cursor", "1.2.3", opts(w, spawn));
    expect(receipt).toMatchObject({ ok: false, code: "version_selection_unsupported" });
    expect(calls.some((call) => call.at(-1) === "update")).toBe(false);
  });

  it("a version-pinned override elsewhere is not updated through another launcher", () => {
    const { w, spawn, calls } = cursorWorld("x");
    const pinned = exe(
      join(w.home, ".local", "share", "cursor-agent", "versions", "old", "cursor-agent"),
      "#!/bin/sh\necho 2025.01.01-old\n",
    );
    const env = { ...w.sourceEnv, CLAUDEXOR_CURSOR_BIN: pinned };
    const row = inspectHarness("cursor", { ...opts(w, spawn), sourceEnv: env });
    expect(row).toMatchObject({
      maintainable: false,
      selection: { kind: "override", binary: pinned },
    });
    const receipt = runHarnessUpdate("cursor", undefined, { ...opts(w, spawn), sourceEnv: env });
    expect(receipt.code).toBe("harness_not_maintainable");
    expect(calls.some((call) => call.at(-1) === "update")).toBe(false);
  });

  it("an alias-only Cursor install (agent -> versions/<v>/cursor-agent) is the selected launcher", () => {
    const w = world();
    const state = join(w.root, "cursor-version");
    writeFileSync(state, "2026.08.11-e8db854");
    const payload = exe(
      join(
        w.home,
        ".local",
        "share",
        "cursor-agent",
        "versions",
        "2026.08.11-e8db854",
        "cursor-agent",
      ),
      `#!/bin/sh\ncat ${state}\n`,
    );
    mkdirSync(join(w.home, ".local", "bin"), { recursive: true });
    symlinkSync(payload, join(w.home, ".local", "bin", "agent"));
    const spawn = vi.fn((_binary: string, argv: readonly string[]) => {
      if (argv.includes("--version"))
        return { status: 0, stdout: `${readFileSync(state, "utf8")}\n`, stderr: "" } as never;
      if (argv[0] === "update") writeFileSync(state, "2026.10.01-e373342");
      return { status: 0, stdout: "", stderr: "" } as never;
    });
    const row = inspectHarness("cursor", opts(w, spawn));
    expect(row).toMatchObject({
      maintainable: true,
      selection: { kind: "path", binary: join(w.home, ".local", "bin", "agent") },
    });
    const receipt = runHarnessUpdate("cursor", undefined, opts(w, spawn));
    expect(receipt).toMatchObject({
      ok: true,
      mutation: "applied",
      after: { version: "2026.10.01-e373342" },
    });
  });

  it("an override naming the canonical launcher shares the vendor recipe", () => {
    const { w, launcher, spawn } = cursorWorld("2026.10.01-e373342");
    const env = { ...w.sourceEnv, CLAUDEXOR_CURSOR_BIN: launcher };
    const receipt = runHarnessUpdate("cursor", "latest", { ...opts(w, spawn), sourceEnv: env });
    expect(receipt).toMatchObject({
      ok: true,
      mutation: "applied",
      before: { selection: "override" },
    });
  });
});
