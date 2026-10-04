import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  inspectExecutable,
  isBoundedRegularExecutable,
  npmGlobalPackagesDir,
  resolveHarnessBinary,
  prepareHarnessCommand,
  resolveHarnessCommandOnPath,
} from "@claudexor/core";

export interface InstalledHarnessProof {
  installedBinary: string;
  installedVersion: string;
}

export type HarnessProofResult =
  { ok: true; proof: InstalledHarnessProof } | { ok: false; reason: string };

export interface InstallProofRuntime {
  runnerNodePath: string;
  platform: NodeJS.Platform;
  /** The runner Node's architecture: it selects the npm platform package and
   * therefore which package-native Windows image is the launcher. */
  arch: string;
  resolutionSource: NodeJS.ProcessEnv;
  environment: NodeJS.ProcessEnv;
  spawn: typeof spawnSync;
}

export interface NpmInstallProofSpec {
  vendorRoot: string;
  npmPackage: string;
  binaryNames: readonly string[];
  expectedVersion: string;
}

const VERSION_PROBE_MAX_BYTES = 1024 * 1024;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const SCRIPT_VENDOR_VERSION_MAX_CHARS = 256;
const SEMVER_TOKEN =
  /(?:^|[^0-9A-Za-z.+-])(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=$|[^0-9A-Za-z.+-])/g;

function isStrictlyContained(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return (
    remainder !== "" &&
    remainder !== ".." &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder)
  );
}

function outputText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

function exactSemverTokens(value: string): string[] {
  return [...value.matchAll(SEMVER_TOKEN)].map((match) => match[1] ?? "");
}

function proveVersion(
  installedBinary: string,
  runtime: InstallProofRuntime,
  expectedVersion: string | null,
  launcher = installedBinary,
): HarnessProofResult {
  const absoluteBinary = resolve(installedBinary);
  const invocation = prepareHarnessCommand(
    launcher,
    ["--version"],
    runtime.environment,
    runtime.platform,
  );
  const versionResult = runtime.spawn(invocation.binary, invocation.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: invocation.env,
    encoding: "utf8",
    timeout: VERSION_PROBE_TIMEOUT_MS,
    maxBuffer: VERSION_PROBE_MAX_BYTES,
  });
  if (versionResult.status !== 0) {
    return {
      ok: false,
      reason: `the absolute --version probe exited ${versionResult.status ?? "without a status"}`,
    };
  }
  const versionOutput = outputText(versionResult.stdout).trim();
  if (versionOutput.length === 0) {
    return { ok: false, reason: "the absolute --version probe returned empty stdout" };
  }
  if (expectedVersion !== null && !exactSemverTokens(versionOutput).includes(expectedVersion)) {
    return {
      ok: false,
      reason: `the absolute --version probe did not report exact semver token ${expectedVersion}`,
    };
  }
  if (expectedVersion !== null) {
    return {
      ok: true,
      proof: { installedBinary: absoluteBinary, installedVersion: expectedVersion },
    };
  }
  const reportedVersion = versionOutput.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (reportedVersion.length === 0 || reportedVersion.length > SCRIPT_VENDOR_VERSION_MAX_CHARS) {
    return {
      ok: false,
      reason: `the --version line must contain 1-${SCRIPT_VENDOR_VERSION_MAX_CHARS} characters`,
    };
  }
  return {
    ok: true,
    proof: { installedBinary: absoluteBinary, installedVersion: reportedVersion },
  };
}

/** Prove an exact npm package and its target-owned launcher, then execute the
 * absolute launcher for a matching version receipt. */
export function proveInstalledNpm(
  spec: NpmInstallProofSpec,
  runtime: InstallProofRuntime,
): HarnessProofResult {
  const packageRoot = join(
    npmGlobalPackagesDir(spec.vendorRoot, runtime.platform),
    ...spec.npmPackage.split("/"),
  );
  let canonicalRoot: string;
  let canonicalPackageRoot: string;
  let canonicalPackageJson: string;
  try {
    canonicalRoot = realpathSync(spec.vendorRoot);
    canonicalPackageRoot = realpathSync(packageRoot);
    canonicalPackageJson = realpathSync(join(packageRoot, "package.json"));
  } catch {
    return { ok: false, reason: "the exact npm package root is missing or unreadable" };
  }
  if (!isStrictlyContained(canonicalRoot, canonicalPackageRoot)) {
    return { ok: false, reason: "the exact npm package root escapes the install prefix" };
  }
  if (!isStrictlyContained(canonicalPackageRoot, canonicalPackageJson)) {
    return { ok: false, reason: "the npm package manifest escapes the exact package root" };
  }
  let packageVersion: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(canonicalPackageJson, "utf8")) as {
      version?: unknown;
    };
    packageVersion = typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return { ok: false, reason: "the exact npm package manifest is unreadable" };
  }
  if (packageVersion !== spec.expectedVersion) {
    return {
      ok: false,
      reason: `the npm package version is ${packageVersion ?? "missing"}, expected ${spec.expectedVersion}`,
    };
  }

  const launcherDir =
    runtime.platform === "win32" ? spec.vendorRoot : resolve(spec.vendorRoot, "bin");
  const launcherSuffix = runtime.platform === "win32" ? ".cmd" : "";
  let installedBinary: string | null = null;
  let launcher: string | null = null;
  for (const binaryName of spec.binaryNames) {
    const candidate = resolve(launcherDir, `${binaryName}${launcherSuffix}`);
    const command = resolveHarnessCommandOnPath(
      candidate,
      runtime.environment.PATH ?? "",
      runtime.platform,
    ).command;
    if (command) {
      installedBinary = command.entrypoint;
      launcher = candidate;
      break;
    }
  }
  if (installedBinary === null) {
    return {
      ok: false,
      reason:
        runtime.platform === "win32"
          ? "the standard npm Windows entrypoint is missing or not launchable"
          : "the expected npm launcher is missing or not launchable",
    };
  }
  try {
    const inspection = inspectExecutable(installedBinary);
    if (!isBoundedRegularExecutable(inspection) || inspection.size === 0) {
      return { ok: false, reason: "the npm launcher target is empty or not a bounded file" };
    }
    if (!isStrictlyContained(canonicalRoot, inspection.realpath)) {
      return { ok: false, reason: "the npm launcher canonical target escapes the install prefix" };
    }
  } catch {
    return { ok: false, reason: "the npm launcher could not be inspected safely" };
  }
  return proveVersion(installedBinary, runtime, spec.expectedVersion, launcher ?? installedBinary);
}

/** Prove a script vendor's launcher (cursor-agent, agy). These installers pick
 * their own destination and ship no pinnable version, so the proof is the
 * resolvable launcher plus its own `--version` line — ONE body for every such
 * vendor, so a third one is a caller, not a fork. The official launcher may be
 * a symlink into a version directory outside bin, which is why resolution goes
 * through the same helper the run path uses. */
export function proveInstalledScriptVendor(
  binaryName: string,
  runtime: InstallProofRuntime,
): HarnessProofResult {
  const installedBinary = resolveHarnessBinary(
    binaryName,
    runtime.resolutionSource,
    runtime.runnerNodePath,
    runtime.platform,
  );
  if (installedBinary === null) {
    return { ok: false, reason: `the exact ${binaryName} launcher is missing or not launchable` };
  }
  try {
    const inspection = inspectExecutable(installedBinary);
    if (!isBoundedRegularExecutable(inspection) || inspection.size === 0) {
      return { ok: false, reason: `the ${binaryName} target is empty or not a bounded file` };
    }
  } catch {
    return { ok: false, reason: `the ${binaryName} launcher could not be inspected safely` };
  }
  return proveVersion(installedBinary, runtime, null);
}
