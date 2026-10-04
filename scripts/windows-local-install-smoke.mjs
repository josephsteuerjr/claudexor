#!/usr/bin/env node
/**
 * Windows managed and ambient npm entrypoint proof, using the exact CI Node.
 * Real pinned Codex/Claude installs must agree with doctor, core launch and
 * idempotent recheck. Authentication remains outside this credential-free smoke.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RECEIPT_FIELDS = [
  "ok",
  "dryRun",
  "exitCode",
  "target",
  "harness",
  "command",
  "installLocation",
  "installedBinary",
  "installedVersion",
  "pinnedVersion",
  "verification",
].sort();
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5 * 60 * 1000;

function fail(message, evidence) {
  console.error(`windows-local-install-smoke FAILED: ${message}`);
  if (evidence !== undefined) console.error(evidence);
  throw new Error(message);
}

function step(message) {
  console.log(`\n== ${message}`);
}

function envValue(name) {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === upper) return value;
  }
  return undefined;
}

if (process.platform !== "win32") fail(`this proof runs on win32 only (got ${process.platform})`);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "packages", "cli", "dist", "cli.js");
if (!existsSync(cli)) fail(`built CLI missing at ${cli} (run pnpm build first)`);
const embeddedNpm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
if (!existsSync(embeddedNpm)) {
  fail(
    `the runner Node has no embedded npm-cli.js at ${embeddedNpm}; stage the official zip layout`,
  );
}

// realpath.native: a `%TEMP%` 8.3 short spelling must not leak into any path
// the engine later canonicalizes (the 3.4.1 Windows lane lesson).
const base = realpathSync.native(process.env.RUNNER_TEMP ?? tmpdir());
const root = mkdtempSync(join(base, "claudexor-win-local-install-"));
const home = join(root, "home");
const configDir = join(root, "config");
const temp = join(root, "tmp");
for (const dir of [
  home,
  configDir,
  temp,
  join(home, "AppData", "Roaming"),
  join(home, "AppData", "Local"),
]) {
  mkdirSync(dir, { recursive: true });
}
const systemRoot = envValue("SystemRoot") ?? "C:\\Windows";
const env = {
  // Windows process environment the OS itself resolves against — and NO
  // node/npm on PATH: the installer must use the runner Node's own npm-cli.js.
  SystemRoot: systemRoot,
  SystemDrive: envValue("SystemDrive") ?? "C:",
  windir: envValue("windir") ?? systemRoot,
  ComSpec: envValue("ComSpec") ?? join(systemRoot, "System32", "cmd.exe"),
  PATHEXT: envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD",
  PATH: [
    join(systemRoot, "System32"),
    systemRoot,
    join(systemRoot, "System32", "Wbem"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
  ].join(";"),
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  TEMP: temp,
  TMP: temp,
  CLAUDEXOR_CONFIG_DIR: configDir,
};
for (const proxy of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]) {
  const value = envValue(proxy);
  if (value !== undefined) env[proxy] = value;
}

step("no ambient node/npm is reachable from the proof environment");
for (const tool of ["node", "npm"]) {
  // Node's spawn cannot execute npm.cmd without a shell; ENOENT alone could
  // misreport that shim as absent. Windows where.exe observes PATHEXT too.
  const where = spawnSync(join(systemRoot, "System32", "where.exe"), [tool], {
    env,
    encoding: "utf8",
  });
  if (where.error || where.status !== 1) {
    fail(`${tool} is reachable or where.exe could not prove absence`, {
      status: where.status,
      error: where.error?.message,
      stdout: where.stdout,
    });
  }
  const probe = spawnSync(tool, ["--version"], { env, encoding: "utf8" });
  if (probe.error?.code !== "ENOENT") {
    fail(`${tool} is reachable on the proof PATH (status ${probe.status})`, probe.stdout);
  }
  console.log(`${tool}: not on PATH (including .cmd/.ps1), as required`);
}

function runCli(args, timeoutMs) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    env,
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`claudexor ${args.join(" ")} could not run: ${result.error.message}`);
  return result;
}

function parseSingleJson(label, stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    fail(`${label} stdout is not exactly one JSON object: ${error.message}`, stdout);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    fail(`${label} stdout is not a JSON object`, stdout);
  }
  return payload;
}

const core = await import(
  pathToFileURL(join(repoRoot, "packages", "core", "dist", "index.js")).href
);
const runtimeEnv = core.harnessRuntimeEnv(env, process.execPath);
const verified = [];

// Core launch accepts an environment patch; delete unselected host variables
// explicitly so these in-process probes share the replacement env of runCli.
function isolatedPatch(desired) {
  const selected = new Set(Object.keys(desired).map((key) => key.toUpperCase()));
  return {
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => !selected.has(key.toUpperCase()))
        .map((key) => [key, null]),
    ),
    ...desired,
  };
}

for (const [harness, npmPackage] of [
  ["codex", "@openai/codex"],
  ["claude", "@anthropic-ai/claude-code"],
]) {
  step(`install ${harness} through the managed npm toolchain`);
  const args = ["harness", "install", harness, "--target", "local", "--yes", "--json"];
  const install = runCli(args, INSTALL_TIMEOUT_MS);
  const receipt = parseSingleJson(`${harness} install`, install.stdout);
  console.log(JSON.stringify(receipt, null, 2));
  if (install.status !== 0 || receipt.ok !== true) fail(`${harness} install failed`, receipt);
  if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(RECEIPT_FIELDS)) {
    fail("receipt keys differ from the embedding-host contract", receipt);
  }
  if (
    receipt.dryRun !== false ||
    receipt.exitCode !== 0 ||
    receipt.target !== "local" ||
    receipt.harness !== harness ||
    receipt.verification !== "release_verified" ||
    typeof receipt.pinnedVersion !== "string" ||
    receipt.installedVersion !== receipt.pinnedVersion
  ) {
    fail(`${harness} receipt facts are inconsistent`, receipt);
  }
  const installedBinary = receipt.installedBinary;
  if (
    typeof installedBinary !== "string" ||
    !isAbsolute(installedBinary) ||
    !existsSync(installedBinary)
  ) {
    fail(`${harness} installedBinary is not an existing absolute entrypoint`, receipt);
  }
  const packageRoot = join(core.managedNodeRoot(home), "node_modules", ...npmPackage.split("/"));
  const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const declared = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.[harness];
  if (
    typeof declared !== "string" ||
    realpathSync.native(installedBinary).toLowerCase() !==
      realpathSync.native(resolve(packageRoot, declared)).toLowerCase()
  ) {
    fail(`${harness} receipt does not name the npm-declared vendor entrypoint`, receipt);
  }
  step(`${harness}: exact entrypoint and bare-name core launch report the pin`);
  for (const input of [installedBinary, harness]) {
    let probe;
    try {
      probe = await core.runCapture(input, ["--version"], {
        env: isolatedPatch(runtimeEnv),
        cwd: root,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    } catch (error) {
      fail(`${harness} core launch failed for ${input}: ${error.message}`);
    }
    if (probe.code !== 0 || !probe.stdout.includes(receipt.pinnedVersion)) {
      fail(`${harness} --version did not report the pin`, probe);
    }
    console.log(`${input}: ${probe.stdout.trim()}`);
  }
  const resolved = core.resolveHarnessBinary(harness, env, process.execPath);
  if (
    typeof resolved !== "string" ||
    realpathSync.native(resolved).toLowerCase() !==
      realpathSync.native(installedBinary).toLowerCase()
  ) {
    fail(`${harness} discovery disagrees with the install receipt`, { resolved, installedBinary });
  }
  const again = runCli(args, INSTALL_TIMEOUT_MS);
  const recheck = parseSingleJson(`${harness} recheck`, again.stdout);
  if (again.status !== 0 || recheck.ok !== true || recheck.installedBinary !== installedBinary) {
    fail(`${harness} repeated install did not recheck the same entrypoint`, recheck);
  }
  // A second real npm prefix proves discovery is not a managed-root special case.
  const ambientPrefix = join(root, `ambient ${harness}`);
  const ambient = spawnSync(
    process.execPath,
    [
      embeddedNpm,
      "install",
      "--global",
      "--prefix",
      ambientPrefix,
      `${npmPackage}@${receipt.pinnedVersion}`,
    ],
    {
      env: runtimeEnv,
      cwd: root,
      encoding: "utf8",
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (ambient.error || ambient.status !== 0)
    fail(`${harness} ambient npm install failed`, ambient.stderr);
  const ambientEnv = { ...runtimeEnv, PATH: `${ambientPrefix};${runtimeEnv.PATH}` };
  const selection = core.resolveHarnessCommandOnPath(harness, ambientEnv.PATH, "win32");
  const expectedAmbient = resolve(
    ambientPrefix,
    "node_modules",
    ...npmPackage.split("/"),
    declared,
  );
  if (
    !selection.command ||
    realpathSync.native(selection.command.entrypoint).toLowerCase() !==
      realpathSync.native(expectedAmbient).toLowerCase()
  ) {
    fail(`${harness} did not select the user's npm prefix`, selection);
  }
  const ambientProbe = await core.runCapture(harness, ["--version"], {
    env: isolatedPatch(ambientEnv),
    cwd: root,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (ambientProbe.code !== 0 || !ambientProbe.stdout.includes(receipt.pinnedVersion)) {
    fail(`${harness} ambient npm entrypoint failed`, ambientProbe);
  }
  verified.push({ harness, installedBinary, version: receipt.pinnedVersion });
}

try {
  step("doctor reports the same vendor entrypoints and exits cleanly");
  const doctor = runCli(["doctor", "--json"], PROBE_TIMEOUT_MS);
  if (doctor.status !== 0 || doctor.signal !== null) {
    fail(`doctor exited ${doctor.status}, signal ${String(doctor.signal)}`, doctor.stdout);
  }
  const report = parseSingleJson("doctor", doctor.stdout);
  for (const entry of verified) {
    const row = report.harnesses?.find((h) => h?.id === entry.harness);
    const installed = row?.checks?.find((check) => check?.id === "installed");
    if (
      installed?.status !== "pass" ||
      typeof installed.detail !== "string" ||
      !installed.detail.toLowerCase().includes(entry.installedBinary.toLowerCase())
    ) {
      fail(`doctor does not identify the installed ${entry.harness} entrypoint`, row);
    }
  }
} finally {
  step("stop only the isolated smoke daemon");
  const stop = runCli(["daemon", "stop", "--json"], PROBE_TIMEOUT_MS);
  const stopped = parseSingleJson("daemon stop", stop.stdout);
  if (stop.status !== 0 || stopped.ok !== true)
    fail("daemon stop did not confirm termination", stopped);
}
console.log(`windows-local-install-smoke: OK ${JSON.stringify(verified)}`);
