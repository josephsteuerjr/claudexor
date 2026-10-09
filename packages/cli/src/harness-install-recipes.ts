/**
 * The vendor RECIPES `claudexor harness install` executes, and the disclosure
 * it prints before executing anything. Split from harness-installer.ts so the
 * WHAT (which artifact, from where, into which prefix, with what evidence)
 * stays readable next to itself, while the installer file owns the HOW
 * (lease, spawn, proof, CLI surface). A new vendor is a row in one of the two
 * tables here, never a new branch there.
 */
import { join } from "node:path";
import { CLAUDE_VENDOR_CLI_VERSION } from "@claudexor/harness-claude";
import { CODEX_VENDOR_CLI_VERSION } from "@claudexor/harness-codex";
import { OPENCODE_VENDOR_CLI_VERSION } from "@claudexor/harness-opencode";
import { copilot } from "@claudexor/harness-acp";
import { resolveCursorBin } from "@claudexor/harness-cursor";
import { managedNodeRoot } from "@claudexor/core";
import type { PinnedVendorCliVersion } from "@claudexor/util";
import { INSTALLABLE_HARNESSES } from "./harness-command-specs.js";

export type InstallableHarness = (typeof INSTALLABLE_HARNESSES)[number];

export function isInstallableHarness(value: string): value is InstallableHarness {
  return INSTALLABLE_HARNESSES.includes(value as InstallableHarness);
}

/** Install destinations. `remote` is the historical issue-#89 SSH-host prefix;
 * `local` is the managed toolchain root this host's harness resolution already
 * reads, so an install there is immediately runnable. */
export const HARNESS_INSTALL_TARGETS = ["local", "remote"] as const;
export type HarnessInstallTarget = (typeof HARNESS_INSTALL_TARGETS)[number];

export function isHarnessInstallTarget(value: string): value is HarnessInstallTarget {
  return HARNESS_INSTALL_TARGETS.includes(value as HarnessInstallTarget);
}

/** ONE table owns each target's npm prefix and how it is disclosed. */
export const TARGET_LAYOUTS: Record<
  HarnessInstallTarget,
  { displayRoot: string; root(home: string): string }
> = {
  local: { displayRoot: "~/.claudexor/node", root: managedNodeRoot },
  remote: {
    displayRoot: "~/.claudexor/remote/vendor",
    root: (home) => join(home, ".claudexor", "remote", "vendor"),
  },
};

/** Exact npm pins. Each version ALIASES the harness package's vendor-version
 * SSOT (vendor-cli-version.ts there). For claude/codex that is the version
 * this release's freshness gates verified; the opencode pin is a
 * deterministic install target only — no recorded verification fixture
 * vouches for it (its vendor-cli-version.ts discloses this). Cursor and agy
 * are absent deliberately: they ship no npm artifact (see SCRIPT_INSTALLERS
 * below). */
export type HarnessInstallVerification =
  | "release_verified"
  | "deterministic_only"
  | "human_observed"
  /** A script vendor installed unattended under an explicit local `--yes`:
   * pinned to nothing and watched by nobody, so the receipt carries the exact
   * installer bytes instead of a human's attention. */
  | "unattended_unpinned";

export const NPM_PINS: Partial<
  Record<
    InstallableHarness,
    {
      npmPackage: string;
      windows?: boolean;
      /** Launcher names the post-install proof executes, in preference order. */
      binaryNames: readonly string[];
      version: PinnedVendorCliVersion;
      verification: Exclude<HarnessInstallVerification, "human_observed" | "unattended_unpinned">;
    }
  >
> = {
  copilot: {
    npmPackage: copilot.npmPackage,
    binaryNames: [copilot.binary],
    version: copilot.version,
    verification: "deterministic_only",
  },
  claude: {
    npmPackage: "@anthropic-ai/claude-code",
    windows: true,
    binaryNames: ["claude"],
    version: CLAUDE_VENDOR_CLI_VERSION,
    verification: "release_verified",
  },
  codex: {
    npmPackage: "@openai/codex",
    windows: true,
    binaryNames: ["codex"],
    version: CODEX_VENDOR_CLI_VERSION,
    verification: "release_verified",
  },
  opencode: {
    npmPackage: "opencode-ai",
    binaryNames: ["opencode"],
    version: OPENCODE_VENDOR_CLI_VERSION,
    verification: "deterministic_only",
  },
};

export const CURSOR_INSTALL_URL = "https://cursor.com/install";
/**
 * Google's official Antigravity CLI installer, as published on
 * antigravity.google/docs/cli/install (`curl -fsSL <this url> | bash`, which
 * Claudexor deliberately does NOT do — see the header). Verified end to end on
 * 2026-08-16: the script fetched from this URL installed agy 1.1.13 to
 * `~/.local/bin/agy`, which is the destination disclosed below. The vendor
 * ships one signed Go binary and no npm package, so it takes the same
 * human-observed path as cursor.
 */
export const AGY_INSTALL_URL = "https://antigravity.google/cli/install.sh";
/** The vendor's Windows installer, from the same documentation page. */
export const AGY_INSTALL_URL_WINDOWS = "https://antigravity.google/cli/install.ps1";

/** Vendors distributed as a shell installer instead of a pinnable npm
 * artifact. ONE branch serves both entries; the per-harness text below is the
 * only thing that differs, so a third such vendor is a row, not a fork. */
const SCRIPT_INSTALLERS: Record<
  "agy" | "cursor",
  {
    url: string;
    windowsUrl?: string;
    installLocation: string;
    pinNote: string;
    /** Launcher the post-install proof resolves and version-probes. */
    binaryName: string;
  }
> = {
  agy: {
    binaryName: "agy",
    url: AGY_INSTALL_URL,
    // The one vendor here that publishes a Windows installer of its own; the
    // POSIX row would otherwise be all Claudexor could honestly offer.
    windowsUrl: AGY_INSTALL_URL_WINDOWS,
    installLocation: "~/.local/bin (as selected by Google's Antigravity installer)",
    pinNote:
      "none — Antigravity ships no pinnable npm artifact; the vendor script is downloaded in full, its size and sha256 print, and it runs in this terminal where you watch it",
  },
  cursor: {
    // The legacy alias every Cursor login/run surface already consumes.
    binaryName: "cursor-agent",
    url: CURSOR_INSTALL_URL,
    installLocation: "~/.local/bin (or ~/.cursor/bin, as selected by Cursor's installer)",
    pinNote:
      "none — Cursor ships no pinnable npm artifact; the vendor script is downloaded in full, its size and sha256 print, and it runs in this terminal where you watch it",
  },
};

type ScriptInstaller = (typeof SCRIPT_INSTALLERS)[keyof typeof SCRIPT_INSTALLERS];

/** Membership is asked of the TABLE, never re-typed: a third script vendor is
 * one row, and cannot be added to the table yet fall through here. */
export function scriptInstaller(harness: InstallableHarness): ScriptInstaller | null {
  return Object.hasOwn(SCRIPT_INSTALLERS, harness)
    ? SCRIPT_INSTALLERS[harness as keyof typeof SCRIPT_INSTALLERS]
    : null;
}

/** The explicit binary override each adapter honours verbatim. A set override
 * means the harness runs THAT program, so maintaining the managed copy would
 * change nothing the harness executes. */
export const HARNESS_BINARY_OVERRIDE_ENV: Record<InstallableHarness, string> = {
  agy: "CLAUDEXOR_AGY_BIN",
  claude: "CLAUDEXOR_CLAUDE_BIN",
  codex: "CLAUDEXOR_CODEX_BIN",
  copilot: copilot.binaryEnv,
  cursor: "CLAUDEXOR_CURSOR_BIN",
  opencode: "CLAUDEXOR_OPENCODE_BIN",
};

/** The command name (or override) the harness adapter itself spawns: Cursor
 * owns its alias choice (`cursor-agent`, else an `agent` inside a Cursor
 * install), every other harness its recipe launcher, an override verbatim. */
const ADAPTER_COMMAND: Partial<
  Record<
    InstallableHarness,
    (env: NodeJS.ProcessEnv, resolve: (bin: string) => string | null) => string
  >
> = { cursor: resolveCursorBin };

export function selectedHarnessCommand(
  harness: InstallableHarness,
  env: NodeJS.ProcessEnv,
  resolve: (bin: string) => string | null,
): string {
  const override = env[HARNESS_BINARY_OVERRIDE_ENV[harness]]?.trim();
  if (override) return override;
  const adapterOwned = ADAPTER_COMMAND[harness];
  if (adapterOwned) return adapterOwned(env, resolve);
  return NPM_PINS[harness]?.binaryNames[0] ?? scriptInstaller(harness)?.binaryName ?? harness;
}

/** How an installed vendor CLI can be maintained. `managed_npm` installs one
 * exact registry version in place; `vendor_updater` runs the vendor's own
 * `update` on the launcher that updater rewrites (it resolves latest itself,
 * so no exact/previous/baseline target exists); `vendor_script` has none. */
export type HarnessMaintenanceMechanism = "managed_npm" | "vendor_updater" | "vendor_script";
export type HarnessMaintenanceTargetKind = "latest" | "version" | "previous" | "baseline";

export interface HarnessMaintenanceRecipe {
  mechanism: HarnessMaintenanceMechanism;
  /** Targets the mechanism can install. Empty = inspection only. */
  targets: readonly HarnessMaintenanceTargetKind[];
  /** vendor_updater: the launchers the vendor's updater rewrites under the
   * installation HOME. A copied or version-pinned launcher is NOT among them. */
  launchers: (home: string) => string[];
}

/** Verified 2026-10-09 (vendor help/source): `agy update` and Cursor's
 * `update` rewrite these POSIX launchers; Windows is not a verified route. */
const VENDOR_UPDATER_LAUNCHERS: Partial<Record<InstallableHarness, readonly string[]>> = {
  agy: ["agy"],
  cursor: ["cursor-agent", "agent"],
};

export function harnessMaintenanceRecipe(
  harness: InstallableHarness,
  platform: NodeJS.Platform = process.platform,
): HarnessMaintenanceRecipe {
  if (NPM_PINS[harness]) {
    return {
      mechanism: "managed_npm",
      targets: ["latest", "version", "previous", "baseline"],
      launchers: () => [],
    };
  }
  const names = VENDOR_UPDATER_LAUNCHERS[harness];
  if (!names || platform === "win32") {
    return { mechanism: "vendor_script", targets: [], launchers: () => [] };
  }
  return {
    mechanism: "vendor_updater",
    targets: ["latest"],
    launchers: (home) => names.map((name) => join(home, ".local", "bin", name)),
  };
}

export interface HarnessInstallerDisclosure {
  harness: InstallableHarness;
  /** Which prefix this disclosure describes; echoed into every receipt. */
  target: HarnessInstallTarget;
  command: string;
  installLocation: string;
  /** Exact vendor version the command installs; null exactly for the script
   * vendors (cursor, agy), which have no pinnable artifact — disclosed, never
   * faked. */
  pinnedVersion: string | null;
  /** Evidence behind the install target. Package-registry integrity verifies
   * downloaded bytes for every npm pin, but only release_verified means the
   * exact vendor version was exercised by this release's freshness gates. */
  verification: HarnessInstallVerification;
}

export function harnessInstallerDisclosure(
  harness: InstallableHarness,
  target: HarnessInstallTarget = "remote",
  platform: NodeJS.Platform = process.platform,
  _arch: string = process.arch,
  /** Explicit exact maintenance target; omitted installs the release pin. The
   * pin stays reported as `pinnedVersion` either way. */
  version?: string,
): HarnessInstallerDisclosure {
  const layout = TARGET_LAYOUTS[target];
  const pin = NPM_PINS[harness];
  const windows = platform === "win32";
  if (pin) {
    const installLocation =
      windows && target === "local"
        ? `${layout.displayRoot}/node_modules/${pin.npmPackage} (npm executable entrypoint)`
        : `${layout.displayRoot}/bin`;
    return {
      harness,
      target,
      command: `npm install --global --prefix ${layout.displayRoot} ${pin.npmPackage}@${version ?? pin.version}`,
      installLocation,
      pinnedVersion: pin.version,
      verification: pin.verification,
    };
  }
  const script = scriptInstaller(harness);
  /* c8 ignore next -- every non-npm harness has a script row; this is the
     unreachable guard that keeps the two tables honest. */
  if (!script) throw new Error(`harness ${harness} has neither an npm pin nor a script installer`);
  const url = windows ? (script.windowsUrl ?? script.url) : script.url;
  const file = windows && script.windowsUrl ? "install.ps1" : "install.sh";
  const runner =
    windows && script.windowsUrl ? "powershell -ExecutionPolicy Bypass -File" : "/bin/sh";
  return {
    harness,
    target,
    command:
      `curl --fail --silent --show-error --location ${url} ` +
      `--output <private-tmpdir>/${file} && ${runner} <private-tmpdir>/${file}`,
    // The vendor script picks its own destination, so the local target cannot
    // move it; only the WITNESS differs between the two targets.
    installLocation:
      windows && script.windowsUrl
        ? "%LOCALAPPDATA%\\agy\\bin (as selected by Google's Antigravity installer)"
        : script.installLocation,
    pinnedVersion: null,
    verification: target === "local" ? "unattended_unpinned" : "human_observed",
  };
}
