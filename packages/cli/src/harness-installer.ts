/**
 * `claudexor harness install` — the disclosed, pinned vendor installer
 * (issue #89; restored from the PR #82 cut with the security objections
 * fixed). The historical/default `remote` target remains the SSH-host flow;
 * an explicit `local` target installs into the managed toolchain root that
 * local harness resolution already owns.
 *
 * Contract:
 * - npm-distributed harnesses (claude/codex/opencode) install ONE exact
 *   version — the per-package vendor-version SSOT — never `@latest`. npm
 *   verifies the registry integrity checksum for an exact version, so the
 *   pin is a real guarantee. For claude/codex that SSOT is the value the
 *   model/effort freshness gates verified; the opencode pin is a
 *   deterministic install target, NOT a verification claim (no recorded
 *   fixture yet — see packages/harness-opencode vendor-cli-version.ts).
 * - cursor and agy have no npm artifact and CANNOT be pinned. Instead of
 *   pretending, the HUMAN is the verifier: the complete vendor script is
 *   downloaded first (never piped to a shell), its size and sha256 are
 *   printed, and it runs in the visible PTY the operator is watching — the
 *   same principle as interactive SSH auth.
 * - NOTHING executes without authorization: the exact command and install
 *   destination print first, and execution needs a TTY confirmation or an
 *   explicit `--yes` (the macOS flow confirms against this module's own
 *   `--dry-run --json` disclosure before passing `--yes`). For a host
 *   integration, `--target local --yes` IS that authorization, granted by the
 *   owner action that invoked it; there is no second confirmation hidden
 *   inside the producer, and the unattended script path never claims the
 *   human-observed verification the watched remote path earns.
 * - concurrent installs into one prefix are serialized by a cross-process
 *   lease. A lease whose owner died is NOT reclaimed automatically: it fails
 *   closed with a typed `install_lock_stale` and the exact cleanup path.
 * - failures are typed and loud; a failed download, a non-zero installer exit,
 *   or a failed post-install binary/version proof never reads as success, and
 *   the temp download dir is removed on every path.
 * - the post-install PROOF is what the local target has instead of a witness.
 *   A watched remote install keeps the historical exit-code contract, because
 *   the operator is looking at the terminal; an unattended local install must
 *   earn its `ok:true`, so exit zero without a resolvable launcher and a
 *   matching `--version` is a typed failure, and `installedBinary` /
 *   `installedVersion` are present on every local success.
 * - on Windows the local target installs only where the pinned npm package
 *   yields a verified package-native image (codex): npm's own `.cmd` shim is
 *   never the launcher, the embedded Node's `node_modules/npm/bin/npm-cli.js`
 *   runs the install, and the proof executes the image the shared harness
 *   PATH resolves; other vendors refuse typed before any side effect.
 * - `--json` keeps stdout pure: exactly ONE JSON object. In json mode every
 *   human progress line goes to stderr and child processes (npm/curl/the
 *   vendor script) run with their stdout routed onto stderr, so vendor
 *   output stays visible without corrupting the machine envelope.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  composeBaseEnv,
  embeddedNpmCli,
  pickAllowlistedEnv,
  WINDOWS_RUNTIME_ENV_KEYS,
  isWindowsNativeArch,
} from "@claudexor/core";
import { flagBool, flagStr, type ParsedArgs } from "./args.js";
import { CliError, renderCliFailure } from "./cli-error.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { INSTALLABLE_HARNESSES } from "./harness-command-specs.js";
import {
  acquireHarnessInstallLease,
  HARNESS_INSTALL_LOCK_TIMEOUT_MS,
  type HarnessInstallLease,
} from "./harness-install-lease.js";
import {
  proveInstalledNpm,
  proveInstalledScriptVendor,
  type HarnessProofResult,
} from "./harness-install-proof.js";

import {
  harnessInstallerDisclosure,
  isHarnessInstallTarget,
  isInstallableHarness,
  NPM_PINS,
  scriptInstaller,
  TARGET_LAYOUTS,
  type HarnessInstallerDisclosure,
  type HarnessInstallTarget,
  type InstallableHarness,
} from "./harness-install-recipes.js";

// The recipe surface is re-exported from its historical home: callers and
// tests import `harness-installer.js`, and the split is an internal one.
export {
  AGY_INSTALL_URL,
  AGY_INSTALL_URL_WINDOWS,
  CURSOR_INSTALL_URL,
  HARNESS_INSTALL_TARGETS,
  harnessInstallerDisclosure,
  isHarnessInstallTarget,
  isInstallableHarness,
  type HarnessInstallTarget,
  type InstallableHarness,
} from "./harness-install-recipes.js";

export interface HarnessInstallRunResult {
  exitCode: number;
  /** Set when the installer refused loudly WITHOUT running the vendor
   * payload (failed/unreadable download); never a silent partial install. */
  refusal?: string;
  /** Stable machine reason when the payload did not run or did not verify. */
  code?: string;
  /** Evidence for the exact unpinned vendor-script bytes that ran. */
  installerSha256?: string;
  installerByteLength?: number;
  /** Present on every SUCCESS: the absolute launcher the proof executed. */
  installedBinary?: string;
  /** Present on every SUCCESS: the exact npm pin, or the script vendor's own
   * trimmed `--version` line. */
  installedVersion?: string;
}

function verificationFailure(
  harness: InstallableHarness,
  reason: string,
  evidence: Pick<HarnessInstallRunResult, "installerSha256" | "installerByteLength"> = {},
): HarnessInstallRunResult {
  return {
    exitCode: 1,
    code: "install_verification_failed",
    refusal: `${harness} installer exited successfully, but installation verification failed: ${reason}`,
    ...evidence,
  };
}

/** A local Windows install is supported exactly where the pinned npm package
 * has declared Windows support for this architecture. Post-install proof uses
 * its standard npm entrypoint, whether native or Node. Other recipes keep
 * their existing platform boundary; the remote target is unaffected. */
function localPlatformRefusal(
  harness: InstallableHarness,
  platform: NodeJS.Platform,
  arch: string,
): HarnessInstallRunResult | null {
  if (platform !== "win32") return null;
  const pin = NPM_PINS[harness];
  if (pin?.windows && isWindowsNativeArch(arch)) return null;
  const refusal = pin
    ? pin.windows === true
      ? `${harness} has no supported Windows npm package for the ${arch} architecture; nothing was executed`
      : `${harness} local Windows installation is not supported by this release: its pinned npm entrypoint has not been verified for Windows; nothing was executed`
    : `--target local is not supported on Windows for ${harness} by this release; nothing was executed`;
  return { exitCode: 1, code: "unsupported_platform", refusal };
}

/** An unexpected throw is still ONE typed JSON object, never a stack trace on
 * a machine caller's stdout. */
function harnessInstallException(error: unknown): CliError {
  const causeCode =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : null;
  const detail = error instanceof Error ? error.message : String(error);
  return new CliError(
    "operational",
    `harness installer failed without a verified result: ${detail}`,
    {
      code: "harness_install_failed",
      ...(causeCode ? { details: { causeCode } } : {}),
    },
  );
}

export function runHarnessInstaller(
  harness: InstallableHarness,
  options: {
    home?: string;
    nodePath?: string;
    /** Explicit install layout. Omitted preserves the historical remote target. */
    target?: HarnessInstallTarget;
    spawn?: typeof spawnSync;
    mkdir?: typeof mkdirSync;
    exists?: typeof existsSync;
    /** Production installs serialize cross-process. Tests may disable only this
     * wrapper while preserving the install recipe under test. */
    lock?: boolean;
    lockTimeoutMs?: number;
    platform?: NodeJS.Platform;
    /** The runner Node's architecture (npm selects the platform package by it). */
    arch?: string;
    /** Test/integration source before the clean allowlist and target-aware PATH
     * normalization are applied. Provider credentials are still scrubbed. */
    sourceEnv?: NodeJS.ProcessEnv;
    /** `--json` stdout purity: route human progress lines AND child stdout
     * to stderr, so stdout carries exactly one JSON object (the caller's
     * final envelope). Human mode keeps everything on stdout as before. */
    json?: boolean;
  } = {},
): HarnessInstallRunResult {
  // Anchored on the SAME `HOME` the harness PATH producer reads, so the prefix
  // this installs into is the prefix doctor/login/run resolve — on Windows
  // `homedir()` follows USERPROFILE and would silently diverge from a scoped
  // HOME.
  const home = resolve(options.home ?? ((options.sourceEnv ?? process.env).HOME || homedir()));
  const target = options.target ?? "remote";
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (target === "local") {
    const unsupported = localPlatformRefusal(harness, platform, arch);
    if (unsupported) return unsupported;
  }
  const spawn = options.spawn ?? spawnSync;
  const json = options.json === true;
  const runnerNodePath = resolve(options.nodePath ?? process.execPath);
  // stdin inherited; child stdout -> OUR stderr (fd 2) in json mode so
  // vendor/npm output stays visible but never pollutes the JSON envelope.
  const childStdio: "inherit" | [number, number, number] = json ? [0, 2, 2] : "inherit";
  const note = (line: string): void => {
    if (json) process.stderr.write(line + "\n");
    else print(line);
  };
  // Vendor-controlled npm/curl/shell children receive the shared minimal
  // runtime env, never the parent process's provider credentials.
  const resolutionSource = {
    ...(options.sourceEnv ?? process.env),
    HOME: home,
    // Local resolution must not read the SSH-runtime vendor prefix; the remote
    // flow keeps whatever its own runtime already exported.
    ...(target === "local" ? { CLAUDEXOR_REMOTE_RUNTIME: "0" } : {}),
  };
  const environment = {
    ...composeBaseEnv("clean", resolutionSource, runnerNodePath, platform),
    // npm and the vendor image cannot start on Windows without the process
    // environment the OS itself resolves against (the login/setup lanes
    // forward the same named set).
    ...(platform === "win32"
      ? pickAllowlistedEnv(resolutionSource, WINDOWS_RUNTIME_ENV_KEYS, platform)
      : {}),
    HOME: home,
  };
  const pin = NPM_PINS[harness];
  const script = scriptInstaller(harness);
  let npmCLI: string | undefined;
  if (pin) {
    npmCLI = embeddedNpmCli(runnerNodePath, platform);
    if (!(options.exists ?? existsSync)(npmCLI)) {
      return {
        exitCode: 1,
        code: "embedded_npm_missing",
        refusal:
          `the bundled npm entrypoint is missing at ${npmCLI} ` +
          "(expected inside the pinned Node runtime next to this CLI); nothing was executed",
      };
    }
  }
  const proofRuntime = { runnerNodePath, platform, arch, resolutionSource, environment, spawn };
  // The remote target runs in a PTY the operator is watching and keeps the
  // historical exit-code contract. Only the unattended local target has to
  // prove what it installed.
  const proofRequired = target === "local";
  const proveInstalled = (): HarnessProofResult =>
    pin
      ? proveInstalledNpm(
          {
            vendorRoot: TARGET_LAYOUTS[target].root(home),
            npmPackage: pin.npmPackage,
            binaryNames: pin.binaryNames,
            expectedVersion: pin.version,
          },
          proofRuntime,
        )
      : /* c8 ignore next -- every non-npm harness has a script row */
        proveInstalledScriptVendor(script?.binaryName ?? harness, proofRuntime);

  let lease: HarnessInstallLease | undefined;
  try {
    // Serialization belongs to the same contract as the proof: a machine caller
    // can race itself, while the remote flow is one operator watching one
    // terminal. Taking the lease there would add a 120s block and a manual
    // cleanup step to a path this release promises to leave alone.
    if (proofRequired && options.lock !== false) {
      try {
        lease = acquireHarnessInstallLease(
          home,
          options.lockTimeoutMs ?? HARNESS_INSTALL_LOCK_TIMEOUT_MS,
        );
      } catch (error) {
        const code =
          typeof (error as { code?: unknown }).code === "string"
            ? String((error as { code: string }).code)
            : "install_lock_failed";
        return {
          exitCode: 1,
          code,
          refusal: `${error instanceof Error ? error.message : String(error)}; nothing was executed`,
        };
      }
    }

    if (pin && npmCLI) {
      const vendorRoot = TARGET_LAYOUTS[target].root(home);
      const alreadyInstalled = proofRequired ? proveInstalled() : null;
      if (alreadyInstalled?.ok) {
        note(`${harness} ${pin.version} is already installed at ${vendorRoot}; nothing to change`);
        return { exitCode: 0, ...alreadyInstalled.proof };
      }
      (options.mkdir ?? mkdirSync)(vendorRoot, { recursive: true, mode: 0o700 });
      const result = spawn(
        runnerNodePath,
        [npmCLI, "install", "--global", "--prefix", vendorRoot, `${pin.npmPackage}@${pin.version}`],
        { stdio: childStdio, env: environment },
      );
      if (result.status !== 0) return { exitCode: result.status ?? 1 };
      if (!proofRequired) return { exitCode: 0 };
      const installed = proveInstalled();
      return installed.ok
        ? { exitCode: 0, ...installed.proof }
        : verificationFailure(harness, installed.reason);
    }

    // Script vendors (cursor, agy): download the COMPLETE vendor script before
    // execution (`--fail` rejects HTTP error bodies), read it back and record
    // its size + sha256 so the receipt names exactly which bytes ran. Remote
    // execution stays human-observed; local `--yes` is explicitly authorized
    // unattended execution. The private temp dir is removed on every path.
    /* c8 ignore next */
    if (!script)
      return {
        exitCode: 1,
        code: "no_installer",
        refusal: `no installer is defined for ${harness}`,
      };
    const alreadyInstalled = proofRequired ? proveInstalled() : null;
    if (alreadyInstalled?.ok) {
      note(
        `${harness} is already installed at ${alreadyInstalled.proof.installedBinary}; nothing to change`,
      );
      return { exitCode: 0, ...alreadyInstalled.proof };
    }
    const windows = platform === "win32";
    const useWindowsScript = windows && script.windowsUrl !== undefined;
    const url = useWindowsScript ? script.windowsUrl! : script.url;
    if (windows && !useWindowsScript) {
      return {
        exitCode: 1,
        code: "unsupported_platform",
        refusal: `${harness} publishes no Windows installer; install it yourself and re-run \`claudexor doctor\``,
      };
    }
    const temporaryDirectory = mkdtempSync(join(tmpdir(), `claudexor-${harness}-install-`));
    const installerPath = join(temporaryDirectory, useWindowsScript ? "install.ps1" : "install.sh");
    try {
      const downloaded = spawn(
        "curl",
        // `url`, never `script.url`: on Windows the disclosure names the
        // vendor's PowerShell installer, and the bytes fetched MUST be the bytes
        // disclosed — both reviewers of the sprint triad caught the divergence.
        ["--fail", "--silent", "--show-error", "--location", url, "--output", installerPath],
        { stdio: childStdio, env: environment },
      );
      if (downloaded.status !== 0) {
        return {
          exitCode: downloaded.status ?? 1,
          code: "installer_download_failed",
          refusal: `the download of ${url} failed (curl exit ${downloaded.status ?? "unknown"}); nothing was executed`,
        };
      }
      let payload: Buffer;
      try {
        payload = readFileSync(installerPath);
      } catch {
        return {
          exitCode: 1,
          code: "installer_read_failed",
          refusal: "the downloaded installer script could not be read back; nothing was executed",
        };
      }
      // Local only: an unattended install must not "run" an empty body and
      // report success. The watched remote flow keeps upstream's behaviour —
      // the human sees "0 bytes" printed and the vendor script exit honestly.
      if (proofRequired && payload.length === 0) {
        return {
          exitCode: 1,
          code: "installer_empty",
          refusal: "the downloaded installer script is empty; nothing was executed",
        };
      }
      const installerSha256 = createHash("sha256").update(payload).digest("hex");
      const installerByteLength = payload.length;
      note(
        `${harness} installer downloaded: ${installerByteLength} bytes, sha256 ${installerSha256}`,
      );
      const runner: [string, string[]] = useWindowsScript
        ? ["powershell", ["-ExecutionPolicy", "Bypass", "-File", installerPath]]
        : ["/bin/sh", [installerPath]];
      note(`running: ${runner[0]} ${runner[1].join(" ")}`);
      const executed = spawn(runner[0], runner[1], { stdio: childStdio, env: environment });
      if (executed.status !== 0) {
        return { exitCode: executed.status ?? 1, installerSha256, installerByteLength };
      }
      if (!proofRequired) return { exitCode: 0 };
      const installed = proveInstalled();
      return installed.ok
        ? { exitCode: 0, installerSha256, installerByteLength, ...installed.proof }
        : verificationFailure(harness, installed.reason, { installerSha256, installerByteLength });
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  } finally {
    lease?.release();
  }
}

const INSTALL_USAGE = `usage: claudexor harness install <${INSTALLABLE_HARNESSES.join("|")}> [--target <local|remote>] [--dry-run] [--yes]`;

function pinDisclosureLine(disclosure: HarnessInstallerDisclosure): string {
  if (disclosure.pinnedVersion === null) {
    if (disclosure.verification === "unattended_unpinned") {
      return (
        "Version pin:      none — this vendor ships no pinnable artifact; this authorized " +
        "unattended install records the downloaded script's size and sha256 instead of a human's attention"
      );
    }
    return `Version pin:      ${scriptInstaller(disclosure.harness)?.pinNote ?? "none"}`;
  }
  if (disclosure.verification === "deterministic_only") {
    return `Version pin:      ${disclosure.pinnedVersion} (exact; deterministic install target — not covered by recorded verification fixtures; npm verifies its registry integrity checksum)`;
  }
  return `Version pin:      ${disclosure.pinnedVersion} (exact; the version this release was verified against — npm verifies its registry integrity checksum)`;
}

function printHumanDisclosure(disclosure: HarnessInstallerDisclosure): void {
  print(`Harness:          ${disclosure.harness}`);
  print(`Command:          ${disclosure.command}`);
  print(`Install location: ${disclosure.installLocation}`);
  print(pinDisclosureLine(disclosure));
}

/** Blocking y/N read on the controlling TTY (fd 0). Anything but an explicit
 * yes declines — closing stdin or an unreadable terminal never installs. */
function confirmOnTty(question: string): boolean {
  process.stdout.write(question);
  const buffer = Buffer.alloc(1024);
  let input = "";
  while (!input.includes("\n")) {
    let bytesRead = 0;
    try {
      bytesRead = readSync(0, buffer, 0, buffer.length, null);
    } catch {
      return false;
    }
    if (bytesRead === 0) break;
    input += buffer.toString("utf8", 0, bytesRead);
  }
  return /^y(es)?$/i.test(input.trim());
}

export function harnessInstallCommand(
  args: ParsedArgs,
  json: boolean,
  /** Test seam: forwarded to `runHarnessInstaller` (spawn/home/... fakes). */
  runnerOptions: Omit<
    NonNullable<Parameters<typeof runHarnessInstaller>[1]>,
    "json" | "target"
  > = {},
): number {
  const harness = args._[2] ?? "";
  if (!isInstallableHarness(harness) || args._.length !== 3) {
    return printUsageError(json, INSTALL_USAGE);
  }
  const targetValue = flagStr(args, "target");
  if (
    (Object.prototype.hasOwnProperty.call(args.flags, "target") && targetValue === undefined) ||
    (targetValue !== undefined && !isHarnessInstallTarget(targetValue))
  ) {
    return printUsageError(json, `${INSTALL_USAGE}\nclaudexor: --target must be local or remote`);
  }
  const target = targetValue ?? "remote";
  const platform = runnerOptions.platform ?? process.platform;
  const arch = runnerOptions.arch ?? process.arch;
  const disclosure = harnessInstallerDisclosure(harness, target, platform, arch);
  // Refuse the unsupported layout BEFORE the dry run, so a machine caller's
  // disclosure never advertises an install this host cannot perform.
  if (target === "local") {
    const unsupported = localPlatformRefusal(harness, platform, arch);
    if (unsupported) {
      if (json)
        printJson({ ok: false, dryRun: flagBool(args, "dry-run"), ...unsupported, ...disclosure });
      else print(`Install refused: ${unsupported.refusal}`);
      return 1;
    }
  }
  if (flagBool(args, "dry-run")) {
    if (json) printJson({ ok: true, dryRun: true, ...disclosure });
    else printHumanDisclosure(disclosure);
    return 0;
  }
  // Disclosure precedes EVERY execution path; --json without --yes refuses
  // (machine callers must have shown the dry-run disclosure themselves, and a
  // local `--yes` IS the authorization their owning Connect action granted).
  if (!json) printHumanDisclosure(disclosure);
  if (!flagBool(args, "yes")) {
    if (json || !process.stdin.isTTY) {
      if (json) {
        printJson({
          ok: false,
          exitCode: 1,
          code: "confirmation_required",
          message: "pass --yes after showing the --dry-run disclosure, or run on a TTY",
          ...disclosure,
        });
      } else {
        print("Not installing: confirm with --yes, or run on an interactive terminal to be asked.");
      }
      return 1;
    }
    if (!confirmOnTty(`Run this installer for ${harness}? [y/N] `)) {
      print("Cancelled; nothing was installed.");
      return 1;
    }
  }
  let result: HarnessInstallRunResult;
  try {
    result = runHarnessInstaller(harness, { ...runnerOptions, json, target });
  } catch (error) {
    return renderCliFailure(json, harnessInstallException(error), {
      messagePrefix: "claudexor harness install:",
      extras: { dryRun: false, ...disclosure },
    });
  }
  const ok = result.exitCode === 0 && result.refusal === undefined;
  if (json) {
    printJson({ ok, dryRun: false, ...result, ...disclosure });
  } else if (result.refusal !== undefined) {
    print(`Install refused: ${result.refusal}`);
  } else if (!ok) {
    print(`Installer exited with code ${result.exitCode}; ${harness} was NOT installed cleanly.`);
  } else {
    print(`Installer finished. Run \`claudexor doctor\` to verify ${harness}.`);
  }
  return ok ? 0 : result.exitCode === 0 ? 1 : result.exitCode;
}
