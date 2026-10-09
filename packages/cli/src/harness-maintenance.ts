/**
 * `claudexor harness inspect|update` — the CLI-first maintenance primitive the
 * daemon's durable operation runs in a child process (so the blocking install
 * never runs on the daemon's event loop and its process tree stays cancellable).
 *
 * - inspect reads facts only: the program the harness actually selects (an
 *   explicit CLAUDEXOR_<HARNESS>_BIN override wins verbatim), its own
 *   `--version`, the managed npm copy, and the release-tested pin as a separate
 *   fact. It never logs in, provisions or installs; `--latest` adds one
 *   registry read of the newest published version.
 * - update performs exactly ONE step through the recipe's mechanism: an exact
 *   managed npm install (latest resolved once to an exact version first), or
 *   the vendor's own `update` on the canonical host-home launcher it rewrites.
 *   The vendor resolves latest itself, so an unchanged version afterwards is
 *   reported as no observed change, never as a new version.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { prepareHarnessCommand, resolveHarnessBinary } from "@claudexor/core";
import { ControlProblem, type HarnessMaintenanceEntry } from "@claudexor/schema";
import { flagBool, flagStr, type ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import {
  acquireHarnessInstallLease,
  HARNESS_INSTALL_LOCK_TIMEOUT_MS,
} from "./harness-install-lease.js";
import {
  EXACT_VENDOR_VERSION,
  exactSemverTokens,
  managedNpmPackageVersion,
  proveInstalledNpm,
  proveInstalledScriptVendor,
} from "./harness-install-proof.js";
import {
  HARNESS_BINARY_OVERRIDE_ENV,
  harnessMaintenanceRecipe,
  isInstallableHarness,
  NPM_PINS,
  selectedHarnessCommand,
  TARGET_LAYOUTS,
  type InstallableHarness,
} from "./harness-install-recipes.js";
import { installerRuntime, type InstallerRuntime } from "./harness-install-runtime.js";
import { confirmOnTty, localPlatformRefusal, runHarnessInstaller } from "./harness-installer.js";
import { INSTALLABLE_HARNESSES } from "./harness-command-specs.js";
import { embeddedNpmCli } from "@claudexor/core";

export type HarnessInspection = Omit<HarnessMaintenanceEntry, "previous" | "operation">;
type Selection = HarnessInspection["selection"];

export interface MaintenanceOptions {
  home?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  sourceEnv?: NodeJS.ProcessEnv;
  spawn?: InstallerRuntime["spawn"];
  now?: () => Date;
  lock?: boolean;
  json?: boolean;
}

const LATEST_TIMEOUT_MS = 30_000;

function runtimeFor(options: MaintenanceOptions): InstallerRuntime {
  return installerRuntime({ ...options, target: "local" });
}

function contained(root: string, candidate: string): boolean {
  try {
    const rest = relative(realpathSync(root), realpathSync(candidate));
    return rest !== "" && !rest.startsWith(`..${sep}`) && rest !== ".." && !isAbsolute(rest);
  } catch {
    return false;
  }
}

/** The selected program's own version answer: its exact semver token when it
 * prints one, else its bounded first line; null when it does not answer. */
function selectedVersion(binary: string | null, runtime: InstallerRuntime): string | null {
  if (!binary) return null;
  const probe = proveInstalledScriptVendor(binary, runtime);
  if (!probe.ok) return null;
  return exactSemverTokens(probe.proof.installedVersion)[0] ?? probe.proof.installedVersion;
}

function selection(harness: InstallableHarness, runtime: InstallerRuntime): Selection {
  const overrideEnv = HARNESS_BINARY_OVERRIDE_ENV[harness];
  const override = runtime.resolutionSource[overrideEnv]?.trim() || null;
  const resolveOnPath = (bin: string) =>
    resolveHarnessBinary(bin, runtime.resolutionSource, runtime.runnerNodePath, runtime.platform);
  const binary = resolveOnPath(
    selectedHarnessCommand(harness, runtime.resolutionSource, resolveOnPath),
  );
  const managed = binary !== null && contained(TARGET_LAYOUTS.local.root(runtime.home), binary);
  return {
    kind: override ? "override" : binary === null ? "missing" : managed ? "managed" : "path",
    binary,
    version: selectedVersion(binary, runtime),
    overrideEnv: override ? overrideEnv : null,
  };
}

/** One registry read of the newest published version, through the embedded
 * npm and the clean vendor environment (no credentials). */
export function resolveLatestNpmVersion(
  harness: InstallableHarness,
  runtime: InstallerRuntime,
): { version: string } | { problem: { code: string; message: string } } {
  const pin = NPM_PINS[harness];
  if (!pin)
    return { problem: { code: "latest_unsupported", message: `${harness} has no npm recipe` } };
  const result = runtime.spawn(
    runtime.runnerNodePath,
    [
      embeddedNpmCli(runtime.runnerNodePath, runtime.platform),
      "view",
      `${pin.npmPackage}@latest`,
      "version",
      "--json",
    ],
    {
      env: runtime.environment,
      encoding: "utf8",
      timeout: LATEST_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let value: unknown = null;
  try {
    value = JSON.parse(String(result.stdout ?? "").trim());
  } catch {
    value = null;
  }
  return result.status === 0 && typeof value === "string" && EXACT_VENDOR_VERSION.test(value)
    ? { version: value }
    : {
        problem: {
          code: "latest_unavailable",
          message: `the registry did not answer one exact latest version for ${pin.npmPackage} (npm exit ${result.status ?? "none"})`,
        },
      };
}

export function inspectHarness(
  harness: InstallableHarness,
  options: MaintenanceOptions & { latest?: boolean } = {},
): HarnessInspection {
  const runtime = runtimeFor(options);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const recipe = harnessMaintenanceRecipe(harness, runtime.platform);
  const pin = NPM_PINS[harness];
  const selected = selection(harness, runtime);
  const root = TARGET_LAYOUTS.local.root(runtime.home);
  const declared = pin ? managedNpmPackageVersion(root, pin.npmPackage, runtime.platform) : null;
  const proof =
    pin && declared
      ? proveInstalledNpm(
          {
            vendorRoot: root,
            npmPackage: pin.npmPackage,
            binaryNames: pin.binaryNames,
            expectedVersion: declared,
          },
          runtime,
        )
      : null;
  let remedy: string | null = null;
  if (recipe.mechanism === "vendor_script") {
    remedy = `${harness} has no engine-run updater on this platform; update it with the vendor's own installer or updater`;
  } else if (recipe.mechanism === "managed_npm") {
    const refusal = localPlatformRefusal(harness, runtime.platform, runtime.arch);
    if (refusal) remedy = refusal.refusal ?? "unsupported platform";
    else if (selected.kind === "override")
      remedy = `${selected.overrideEnv} selects ${selected.binary ?? "an unresolvable program"}; update that program yourself or unset the override to use the managed copy`;
    else if (selected.kind === "path")
      remedy = `${selected.binary} is installed outside Claudexor's managed prefix; update it with the tool that installed it (a managed install would silently take over the selection)`;
  } else if (!selected.binary || !recipe.launchers(runtime.home).includes(selected.binary)) {
    // The vendor updater rewrites the launchers under the installation HOME the
    // engine runs with (and passes on to it); a copied/pinned launcher elsewhere
    // would stay unchanged while another one is updated.
    remedy = selected.binary
      ? `${selected.binary} is not the launcher ${harness}'s own updater maintains under ${runtime.home}/.local/bin; update it with the tool that installed it`
      : `${harness} is not installed; install it with \`claudexor harness install ${harness}\``;
  }
  const canCheckLatest = recipe.mechanism === "managed_npm";
  const latest = !options.latest
    ? null
    : canCheckLatest
      ? resolveLatestNpmVersion(harness, runtime)
      : {
          problem: {
            code: "latest_check_unsupported",
            message: `${harness}'s ${recipe.mechanism} mechanism has no implemented newest-release check; Update still asks the vendor for its latest release`,
          },
        };
  return {
    harness,
    mechanism: recipe.mechanism,
    maintainable: remedy === null,
    canCheckLatest,
    targets: remedy === null ? [...recipe.targets] : [],
    remedy,
    selection: selected,
    installed: {
      version: declared,
      binary: proof?.ok ? proof.proof.installedBinary : null,
      proved: proof?.ok === true,
    },
    releaseTested: { version: pin?.version ?? null, verification: pin?.verification ?? null },
    available: latest && "version" in latest ? { version: latest.version, observedAt: now } : null,
    availableProblem:
      latest && "problem" in latest
        ? ControlProblem.parse({
            ...latest.problem,
            retryable: latest.problem.code !== "latest_check_unsupported",
          })
        : null,
    observedAt: now,
  };
}

export interface HarnessUpdateReceipt {
  ok: boolean;
  harness: InstallableHarness;
  mechanism: HarnessInspection["mechanism"];
  exitCode: number;
  code?: string;
  refusal?: string;
  requestedVersion: string | null;
  resolvedVersion: string | null;
  previousVersion: string | null;
  before: {
    version: string | null;
    binary: string | null;
    selection: Selection["kind"];
    proved: boolean;
  };
  after: {
    version: string | null;
    binary: string | null;
    selected: boolean;
    proved: boolean;
  } | null;
  mutation: "none" | "applied" | "unknown";
  limitations: string[];
}

/** Exactly one maintenance step. `requested` is an exact version, "latest", or
 * omitted (latest for either mechanism). */
export function runHarnessUpdate(
  harness: InstallableHarness,
  requested: string | undefined,
  options: MaintenanceOptions = {},
): HarnessUpdateReceipt {
  const before = inspectHarness(harness, options);
  const runtime = runtimeFor(options);
  const base = {
    harness,
    mechanism: before.mechanism,
    requestedVersion: requested ?? null,
    resolvedVersion: null as string | null,
    previousVersion: null as string | null,
    before: {
      version:
        before.mechanism === "managed_npm" ? before.installed.version : before.selection.version,
      binary:
        before.mechanism === "managed_npm" ? before.installed.binary : before.selection.binary,
      selection: before.selection.kind,
      proved:
        before.mechanism === "managed_npm"
          ? before.installed.proved
          : before.selection.version !== null,
    },
    after: null,
    limitations: ["in_place_replacement", "new_starts_may_fail"],
  };
  const refuse = (code: string, refusal: string): HarnessUpdateReceipt => ({
    ...base,
    ok: false,
    exitCode: 1,
    code,
    refusal: `${refusal}; nothing was executed`,
    mutation: "none",
  });
  if (!before.maintainable)
    return refuse("harness_not_maintainable", before.remedy ?? "not maintainable");
  if (before.mechanism === "vendor_updater") {
    if (requested !== undefined && requested !== "latest")
      return refuse(
        "version_selection_unsupported",
        `${harness}'s own updater installs only its latest release`,
      );
    return vendorUpdate(harness, runtime, base, options);
  }
  let exact = requested ?? "latest";
  if (exact === "latest") {
    const latest = resolveLatestNpmVersion(harness, runtime);
    if ("problem" in latest) return refuse(latest.problem.code, latest.problem.message);
    exact = latest.version;
  }
  if (!EXACT_VENDOR_VERSION.test(exact))
    return refuse("invalid_vendor_version", `${exact} is not one exact version`);
  const result = runHarnessInstaller(harness, {
    ...options,
    ...runtime,
    target: "local",
    version: exact,
    json: options.json,
  });
  const attempted = "previousVersion" in result;
  const after = selection(harness, runtime);
  const ok = result.exitCode === 0 && result.refusal === undefined;
  return {
    ...base,
    ok,
    exitCode: ok ? 0 : result.exitCode || 1,
    ...(result.code ? { code: result.code } : {}),
    ...(result.refusal ? { refusal: result.refusal } : {}),
    resolvedVersion: exact,
    previousVersion: attempted ? (result.previousVersion ?? null) : base.before.version,
    after: {
      version: ok ? (result.installedVersion ?? null) : null,
      binary: result.installedBinary ?? null,
      selected: ok && after.kind === "managed",
      proved: ok,
    },
    mutation: ok ? (attempted ? "applied" : "none") : attempted ? "unknown" : "none",
  };
}

function vendorUpdate(
  harness: InstallableHarness,
  runtime: InstallerRuntime,
  base: Omit<HarnessUpdateReceipt, "ok" | "exitCode" | "mutation">,
  options: MaintenanceOptions,
): HarnessUpdateReceipt {
  const binary = base.before.binary!;
  let lease: { release(): void } | null = null;
  try {
    if (options.lock !== false)
      lease = acquireHarnessInstallLease(runtime.home, HARNESS_INSTALL_LOCK_TIMEOUT_MS);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      ...base,
      ok: false,
      exitCode: 1,
      code: typeof code === "string" ? code : "install_lock_failed",
      refusal: `${error instanceof Error ? error.message : String(error)}; nothing was executed`,
      mutation: "none",
    };
  }
  try {
    const invocation = prepareHarnessCommand(
      binary,
      ["update"],
      runtime.environment,
      runtime.platform,
    );
    const result = runtime.spawn(invocation.binary, invocation.args, {
      env: invocation.env,
      stdio: options.json ? [0, 2, 2] : "inherit",
    });
    const after = selection(harness, runtime);
    const changed = after.version !== null && after.version !== base.before.version;
    const limitations = [
      ...base.limitations,
      "vendor_resolves_latest",
      ...(result.status === 0 && !changed ? ["no_version_change_observed"] : []),
    ];
    return {
      ...base,
      ok: result.status === 0 && after.version !== null,
      exitCode: result.status === 0 ? (after.version !== null ? 0 : 1) : (result.status ?? 1),
      ...(result.status !== 0
        ? { code: result.signal ? "installer_terminated" : "vendor_update_failed" }
        : after.version === null
          ? { code: "install_verification_failed" }
          : {}),
      resolvedVersion: changed ? after.version : null,
      previousVersion: base.before.version,
      after: {
        version: after.version,
        binary: after.binary,
        selected: after.binary === binary,
        proved: after.version !== null,
      },
      mutation:
        result.status === 0 && after.version !== null ? (changed ? "applied" : "none") : "unknown",
      limitations,
    };
  } finally {
    lease?.release();
  }
}

const INSPECT_USAGE = `usage: claudexor harness inspect [<${INSTALLABLE_HARNESSES.join("|")}>] [--latest]`;
const UPDATE_USAGE = `usage: claudexor harness update <${INSTALLABLE_HARNESSES.join("|")}> [--vendor-version <exact|latest>] [--yes]`;

export function harnessInspectCommand(
  args: ParsedArgs,
  json: boolean,
  options: MaintenanceOptions = {},
): number {
  const only = args._[2];
  if ((only !== undefined && !isInstallableHarness(only)) || args._.length > 3)
    return printUsageError(json, INSPECT_USAGE);
  const ids = only ? [only] : [...INSTALLABLE_HARNESSES];
  const rows = ids.map((id) =>
    inspectHarness(id, { ...options, latest: flagBool(args, "latest") }),
  );
  if (json)
    printJson({ observedAt: rows[0]?.observedAt ?? new Date().toISOString(), harnesses: rows });
  else
    for (const row of rows)
      print(
        `${row.harness}: ${row.selection.kind} ${row.selection.binary ?? "-"} ${row.selection.version ?? "version unknown"}` +
          (row.maintainable ? ` (maintainable: ${row.targets.join(", ")})` : ` (${row.remedy})`),
      );
  return 0;
}

export function harnessUpdateCommand(
  args: ParsedArgs,
  json: boolean,
  options: MaintenanceOptions = {},
): number {
  const harness = args._[2] ?? "";
  if (!isInstallableHarness(harness) || args._.length !== 3)
    return printUsageError(json, UPDATE_USAGE);
  const requested = flagStr(args, "vendor-version");
  if (!flagBool(args, "yes")) {
    if (json || !process.stdin.isTTY) {
      if (json) printJson({ ok: false, exitCode: 1, code: "confirmation_required", harness });
      else
        print("Not updating: confirm with --yes, or run on an interactive terminal to be asked.");
      return 1;
    }
    if (!confirmOnTty(`Update ${harness} to ${requested ?? "latest"}? [y/N] `)) return 1;
  }
  // A cancelled operation's TERM reaches this process and npm together: stay
  // alive until npm is reaped so the lease is released and a receipt prints.
  const onSignal = (): void => undefined;
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    const receipt = runHarnessUpdate(harness, requested, { ...options, json });
    if (json) printJson(receipt);
    else
      print(
        receipt.ok
          ? `${harness}: ${receipt.before.version ?? "none"} -> ${receipt.after?.version ?? "unknown"}${receipt.mutation === "none" ? " (no change)" : ""}`
          : `${harness} update failed: ${receipt.refusal ?? receipt.code ?? `exit ${receipt.exitCode}`}`,
      );
    return receipt.ok ? 0 : receipt.exitCode || 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}
