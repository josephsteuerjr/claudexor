/**
 * `continueFrom` successor contract on a scripted fake harness (no vendor
 * calls): a predecessor run stops after progress, then a successor run —
 * given exactly the continuation facts the daemon runner resolves — continues
 * it. Asserts the first try's carrier, the spec the successor process
 * receives, the receipt, the chain's work order and the kept/adopted tree.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, HarnessContinuityCapability } from "@claudexor/core";
import {
  ConformanceReport,
  HarnessManifest,
  type HarnessEvent,
  type HarnessRunSpec,
  type RunEvent,
} from "@claudexor/schema";
import { retainedEnvelopeOfRun } from "@claudexor/workspace";
import { Orchestrator, type RunInput } from "./orchestrator.js";
import { readSessionCapsule } from "./session-capsule.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const WORK_ORDER = "WORK-ORDER-7f3a: build the dashboard";
const RESET = "2026-10-06T21:00:00.000Z";

interface Spawn {
  phase: "predecessor" | "successor";
  profile: string;
  resume: string | null;
  prompt: string;
  model: string | null;
  cwd: string;
}

type Emit = (ev: Partial<HarnessEvent>) => HarnessEvent;
type Script = (
  ctx: Spawn & { spec: HarnessRunSpec; emit: Emit; nth: number },
) => Generator<HarnessEvent>;

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-continue-from-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"],
    { cwd: root, stdio: "pipe" },
  );
  return root;
}

/** A movable fake store: sessions live under `<locator>/sessions/<sid>.jsonl`. */
function fileStoreContinuity(): HarnessContinuityCapability {
  const fileFor = (env: Record<string, string | null | undefined>, sid: string) =>
    join(String(env["CLAUDEXOR_PROFILE_LOCATOR"] ?? "/nowhere"), "sessions", `${sid}.jsonl`);
  return {
    async locate(ref, env) {
      const file = fileFor(env, ref.nativeSessionId);
      return existsSync(file)
        ? { found: true, file, mtimeMs: Date.now(), sidecars: [] }
        : { found: false };
    },
    async move(located, _fromEnv, toEnv) {
      const sid = located.nativeSessionId ?? "?";
      const target = fileFor(toEnv, sid);
      execFileSync("mkdir", ["-p", join(target, "..")]);
      writeFileSync(target, readFileSync(located.file));
      rmSync(located.file);
      return { ok: true, resumeRef: { nativeSessionId: sid } };
    },
  };
}

function seedSession(store: string, sid: string): void {
  execFileSync("mkdir", ["-p", join(store, "sessions")]);
  writeFileSync(join(store, "sessions", `${sid}.jsonl`), `{"sid":"${sid}"}\n`);
}

const limit = (emit: Emit) => [
  emit({
    type: "status",
    status: { kind: "api_retry", error_category: "rate_limit" },
    rate_limit: { resets_at: RESET, retry_delay_ms: null, constraint_id: "five_hour" },
  }),
  emit({ type: "error", error: "usage limit reached" }),
  emit({ type: "completed" }),
];
const crash = (emit: Emit) => [
  emit({ type: "error", error: "connection reset" }),
  emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } }),
];

interface Fixture {
  root: string;
  stores: Record<string, string>;
  spawns: Spawn[];
  adapter: HarnessAdapter;
  phase: { current: Spawn["phase"] };
}

function fixture(profiles: string[], script: Script): Fixture {
  const root = gitRepo();
  const configDir = process.env.CLAUDEXOR_CONFIG_DIR!;
  const stores = Object.fromEntries(profiles.map((id) => [id, join(root, `store-${id}`)]));
  writeFileSync(
    join(configDir, "config.yaml"),
    JSON.stringify({
      runtime: { transient_retry: { max_retries: 2, initial_delay_ms: 1, max_delay_ms: 2 } },
      credential_profiles: profiles.map((id) => ({
        profile_id: id,
        harness_id: "fake",
        display_name: id,
        credential_kind: "config_dir_login",
        isolation_locator: stores[id],
      })),
      harnesses: { fake: { profile_policy: { limit_action: "rotate" } } },
    }),
  );
  const spawns: Spawn[] = [];
  const phase = { current: "predecessor" as Spawn["phase"] };
  const adapter: HarnessAdapter = {
    id: "fake",
    continuity: fileStoreContinuity(),
    async discover() {
      return HarnessManifest.parse({
        id: "fake",
        display_name: "fake",
        kind: "local_cli",
        provider_family: "local",
        capabilities: {
          implement: true,
          read_files: true,
          effort_levels: ["high"],
          repair: true,
          explain: true,
          audit: true,
          known_models: ["m1"],
        },
        auth_modes: ["local_session"],
        access_profiles_supported: ["workspace_write", "readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "fake",
        status: "ok",
        enabled_intents: ["implement", "repair", "explain", "audit"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: "fake",
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        last_verified_at: new Date().toISOString(),
      };
    },
    async models() {
      return [{ id: "m1", label: null, context_window: null, routes: null }];
    },
    async *run(spec) {
      const profile = spec.credential_profile!.profile_id;
      const ctx: Spawn = {
        phase: phase.current,
        profile,
        resume: spec.resume_session_id ?? null,
        prompt: spec.prompt,
        model: spec.model_hint ?? null,
        cwd: spec.cwd,
      };
      spawns.push(ctx);
      const nth = spawns.filter((s) => s.phase === ctx.phase).length;
      const emit: Emit = (ev) =>
        ({
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          credential_route: "vendor_native",
          credential_profile_id: profile,
          ...ev,
        }) as HarnessEvent;
      yield* script({ ...ctx, spec, emit, nth });
    },
  };
  return { root, stores, spawns, adapter, phase };
}

async function runOnce(f: Fixture, input: Partial<RunInput>) {
  const events: RunEvent[] = [];
  const result = await new Orchestrator({
    registry: new Map([["fake", f.adapter]]),
    reviewers: [],
  }).run({
    repoRoot: f.root,
    mode: "agent",
    prompt: WORK_ORDER,
    harnesses: ["fake"],
    review: false,
    models: { fake: "m1" },
    effort: "high",
    authPreference: "subscription",
    web: "off",
    ...input,
    onEvent: (event) => events.push(event),
  });
  const receipts = events
    .filter((e) => e.type === "run.continuity")
    .map((e) => e.payload["receipt"] as Record<string, unknown>);
  const terminal = events.find((e) =>
    ["run.failed", "run.completed", "run.blocked"].includes(e.type),
  );
  return {
    result,
    events,
    receipts,
    resumable: terminal?.payload["resumable"] as Record<string, unknown> | undefined,
  };
}

/** The predecessor, then its successor with the facts `continuationForRun` resolves. */
async function chain(
  f: Fixture,
  opts: {
    predecessor?: Partial<RunInput>;
    successor?: Partial<RunInput>;
    preference?: "auto" | "packet";
    between?: (runDir: string) => void;
    adopt?: boolean;
  } = {},
) {
  const pred = await runOnce(f, {
    inPlace: true,
    continuation: { retain: true },
    ...opts.predecessor,
  });
  opts.between?.(pred.result.runDir);
  f.phase.current = "successor";
  const adopt = opts.adopt ? retainedEnvelopeOfRun(pred.result.runDir, pred.result.runId) : null;
  const succ = await runOnce(f, {
    inPlace: true,
    prompt: "Also add tests",
    ...opts.successor,
    continuation: {
      retain: true,
      adopt,
      from: {
        runId: pred.result.runId,
        runDir: pred.result.runDir,
        state: pred.result.lifecycle,
        workOrder: WORK_ORDER,
        preference: opts.preference ?? "auto",
      },
    },
  });
  return { pred, succ };
}

/** Predecessor script: start a session on its profile, edit, then hit a typed limit. */
function editThenLimit(f: () => Fixture): Script {
  return function* ({ phase, profile, spec, emit }) {
    if (phase !== "predecessor") return;
    seedSession(f().stores[profile]!, "sid-A");
    yield emit({ type: "started", observed_model: "m1", payload: { native_session_id: "sid-A" } });
    writeFileSync(join(spec.cwd, "part1.txt"), "first half\n");
    yield emit({ type: "file_change", payload: { path: "part1.txt" } });
    yield* limit(emit);
  };
}

function finishing(emit: Emit, cwd: string, resumed: string): HarnessEvent[] {
  writeFileSync(join(cwd, "part2.txt"), "second half\n");
  return [
    emit({ type: "started", observed_model: "m1", payload: { native_session_id: resumed } }),
    emit({ type: "file_change", payload: { path: "part2.txt" } }),
    emit({ type: "message", text: "Done: both parts.", final: true }),
    emit({ type: "completed" }),
  ];
}

function attemptDirOf(runDir: string): string {
  return join(runDir, "attempts", readdirSync(join(runDir, "attempts")).sort()[0]!);
}

describe("continueFrom successor: first try", () => {
  it("resumes the predecessor's session on the same account with the notice and the caller's text, never the work order", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") return yield* predScript(ctx);
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { pred, succ } = await chain(f);
    expect(pred.result.lifecycle).not.toBe("succeeded");
    expect(pred.resumable).toMatchObject({
      cause: "pool_exhausted",
      session: { nativeSessionId: "sid-A", holderProfileId: "a" },
    });
    expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
    const first = f.spawns.find((s) => s.phase === "successor")!;
    expect(first.resume).toBe("sid-A");
    expect(first.prompt).toContain("The previous process stopped (every account's usage limit)");
    expect(first.prompt).toContain("Also add tests");
    expect(first.prompt).not.toContain(WORK_ORDER);
    expect(succ.receipts).toHaveLength(1);
    expect(succ.receipts[0]).toMatchObject({
      tryIndex: 0,
      carrier: "native",
      cause: "pool_exhausted",
      from: { runId: pred.result.runId, profileId: "a" },
      to: { profileId: "a" },
      workspace: "same_root",
      memory: "full",
      observedModel: "m1",
      modelMismatch: false,
      identityCheck: "matched_before_effects",
      inputDelivery: "confirmed",
    });
    // The chain's work order and the session holder carry over to the successor.
    expect(readFileSync(join(succ.result.runDir, "context", "work-order.md"), "utf8")).toBe(
      `${WORK_ORDER}\n\nAlso add tests\n`,
    );
    expect(readSessionCapsule(attemptDirOf(succ.result.runDir))).toMatchObject({
      nativeSessionId: "sid-A",
      holderProfileId: "a",
    });
    expect(existsSync(join(f.root, "part1.txt")) && existsSync(join(f.root, "part2.txt"))).toBe(
      true,
    );
  });

  it("moves the session to the successor's account when it starts on another one (native_moved)", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a", "b"], function* (ctx) {
      if (ctx.phase === "predecessor") {
        // Pin a: the predecessor ends on a's limit instead of hopping in-run.
        return yield* predScript(ctx);
      }
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { pred, succ } = await chain(f, {
      predecessor: { credentialProfileId: "a" },
      successor: { credentialProfileId: "b" },
    });
    expect(pred.resumable).toMatchObject({ cause: "pinned_limit" });
    const first = f.spawns.find((s) => s.phase === "successor")!;
    expect([first.profile, first.resume]).toEqual(["b", "sid-A"]);
    expect(existsSync(join(f.stores["b"]!, "sessions", "sid-A.jsonl"))).toBe(true);
    expect(existsSync(join(f.stores["a"]!, "sessions", "sid-A.jsonl"))).toBe(false);
    expect(succ.receipts[0]).toMatchObject({
      tryIndex: 0,
      carrier: "native_moved",
      from: { runId: pred.result.runId, profileId: "a" },
      to: { profileId: "b" },
    });
    expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
  });

  it("re-briefs a fresh session when the caller asks for a packet: the evidence index carries the work order", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") return yield* predScript(ctx);
      yield* finishing(ctx.emit, ctx.cwd, "sid-new");
    });
    const { pred, succ } = await chain(f, { preference: "packet" });
    const first = f.spawns.find((s) => s.phase === "successor")!;
    expect(first.resume).toBeNull();
    expect(first.prompt).toContain("Also add tests");
    expect(first.prompt).toContain("evidence index");
    expect(first.prompt).toContain(WORK_ORDER);
    expect(first.model).toBe("m1");
    const index = join(attemptDirOf(succ.result.runDir), "continuation", "evidence-index-try0.md");
    expect(readFileSync(index, "utf8")).toContain("part1.txt");
    expect(succ.receipts[0]).toMatchObject({
      tryIndex: 0,
      carrier: "packet",
      memory: "partial",
      identityCheck: "not_applicable",
      from: { runId: pred.result.runId },
    });
  });

  it("tool-only work + a delivered correction + no answer: the packet successor sees the correction, the undelivered message and the unresolved call", async () => {
    const f = fixture(["a"], function* ({ phase, emit, cwd }) {
      if (phase === "predecessor") {
        yield emit({ type: "started", observed_model: "m1", payload: {} });
        yield emit({
          type: "tool_call",
          tool: { name: "Write", kind: "file", target: "src/chart.ts" },
        });
        yield emit({ type: "tool_result", tool: { name: "Write", kind: "file", status: "ok" } });
        yield emit({
          type: "tool_call",
          tool: { name: "Bash", kind: "command", target: "pnpm test" },
        });
        yield* crash(emit);
        return;
      }
      yield* finishing(emit, cwd, "sid-new");
    });
    const { succ } = await chain(f, {
      between: (runDir) => {
        // Live messages as POST /v2/runs/:id/messages journals them.
        const row = (type: string, id: string, text: string) =>
          `${JSON.stringify({ seq: 900, ts: RESET, run_id: "r", task_id: "t", type, payload: { message_id: id, text } })}\n`;
        appendFileSync(join(runDir, "events.jsonl"), row("message.accepted", "m1", "Use red bars"));
        appendFileSync(
          join(runDir, "events.jsonl"),
          row("message.delivered", "m1", "Use red bars"),
        );
        appendFileSync(
          join(runDir, "events.jsonl"),
          row("message.accepted", "m2", "Also label the axes"),
        );
      },
    });
    const first = f.spawns.find((s) => s.phase === "successor")!;
    // No native session was recorded: the successor is re-briefed.
    expect(first.resume).toBeNull();
    expect(first.prompt).toContain("Use red bars");
    expect(first.prompt).toContain("Write — src/chart.ts (completed)");
    expect(first.prompt).toContain("Bash — pnpm test (unresolved");
    // The undelivered message is a reference to reconcile, never a blind replay.
    expect(first.prompt).toContain("may not have been delivered");
    expect(first.prompt).toContain("Also label the axes");
    expect(succ.receipts[0]).toMatchObject({ inputDelivery: "uncertain", cause: "transport" });
  });

  it("a successor whose first native try dies before progress resumes the session again instead of replaying a context-free notice", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") return yield* predScript(ctx);
      if (ctx.nth === 1) return yield* crash(ctx.emit);
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { succ } = await chain(f);
    const tries = f.spawns.filter((s) => s.phase === "successor");
    expect(tries.map((s) => s.resume)).toEqual(["sid-A", "sid-A"]);
    expect(tries[1]!.prompt).toContain("The previous process stopped (the process died)");
    expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
    expect(succ.receipts.map((r) => [r["tryIndex"], r["carrier"], r["cause"]])).toEqual([
      [0, "native", "pool_exhausted"],
      [1, "native", "transport"],
    ]);
  });
});

describe("continueFrom successor: kept isolated envelope", () => {
  it("adopts the predecessor's kept envelope with the same files; a live successor elsewhere runs in a different root", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") return yield* predScript(ctx);
      expect(readFileSync(join(ctx.cwd, "part1.txt"), "utf8")).toBe("first half\n");
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { pred, succ } = await chain(f, {
      predecessor: { inPlace: false },
      successor: { inPlace: false },
      adopt: true,
    });
    expect(pred.resumable).toMatchObject({ workspace: { kind: "retained_envelope" } });
    const keptRoot = (pred.resumable!["workspace"] as { root: string }).root;
    const first = f.spawns.find((s) => s.phase === "successor")!;
    expect(first.cwd).toBe(keptRoot);
    expect(succ.receipts[0]).toMatchObject({ carrier: "native", workspace: "same_root" });
    // One cumulative patch: the predecessor's half and the successor's half.
    expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
    const patch = readFileSync(join(succ.result.runDir, "final", "patch.diff"), "utf8");
    expect(patch).toContain("part1.txt");
    expect(patch).toContain("part2.txt");
    // The finished successor released the kept tree.
    expect(retainedEnvelopeOfRun(pred.result.runDir, pred.result.runId)).toBeNull();
    expect(existsSync(keptRoot)).toBe(false);
  });

  it("names a different root when the successor runs live elsewhere", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") return yield* predScript(ctx);
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { pred, succ } = await chain(f, { predecessor: { inPlace: false } });
    expect(succ.receipts[0]).toMatchObject({ carrier: "native", workspace: "different_root" });
    // The predecessor's kept tree stays kept until its own disposition.
    expect(retainedEnvelopeOfRun(pred.result.runDir, pred.result.runId)).not.toBeNull();
  });
});
