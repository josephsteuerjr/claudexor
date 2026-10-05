/**
 * Envelope custody of a single-candidate Agent run (A9, PLAN §2.2).
 *
 * Start: a `continueFrom` successor adopts its predecessor's retained envelope
 * (same path, base and files); any other single-candidate mutating run gets a
 * fresh isolated envelope with `live` custody recorded before the harness runs.
 * End: the envelope is kept (`retained`) when the work stopped unfinished
 * (cancelled, errored, or a needs_input / incomplete report) AND there is
 * something to continue (a tree that differs from its base, or a native
 * session capsule); otherwise it is disposed as before. Race candidates,
 * synthesis, review and in-place envelopes are untouched.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventLog } from "@claudexor/event-log";
import type { EnvelopeCustody, ResumableCause, WorkspaceEnvelope } from "@claudexor/schema";
import {
  adoptRetainedEnvelope,
  envelopeBaseOf,
  envelopeTreeChanged,
  readEnvelopeCustody,
  retainForContinuation,
  type CreateEnvelopeOptions,
  type WorkspaceManager,
} from "@claudexor/workspace";
import type { CandidateRun } from "./candidateEvidence.js";

interface EnvelopeHolder {
  runId: string;
  runDir: string;
}

/** The per-attempt native session capsule file, written by the in-run
 * continuation loop when `started` reports a native session id. */
export function sessionCapsuleFile(attemptDir: string): string {
  return join(attemptDir, "session-capsule.json");
}

/** What the daemon hands a run about continuation (`RunInput.continuation`). */
export interface RunContinuation {
  /** Keep this run's stopped work for `continueFrom`. Only a daemon-owned run
   * sets it: only the daemon admits a successor or discards a kept envelope. */
  retain: boolean;
  /** The predecessor's retained envelope this run adopts (`continueFrom`). */
  adopt?: EnvelopeCustody | null;
}

/**
 * The custody hooks of one run's candidate slot: `envelope` creates (or, for a
 * `continueFrom` successor, adopts) the candidate's envelope; `settle` keeps or
 * disposes it when the candidate ends. Only a daemon-owned, single-candidate,
 * mutating run (`keepable`) records custody; every other run keeps today's
 * create/dispose behaviour.
 */
export function forRun(
  input: { continuation?: RunContinuation; signal?: AbortSignal },
  keepable: boolean,
  runId: string,
  paths: { root: string; attemptsDir: string },
  log?: EventLog,
) {
  const holder: EnvelopeHolder | null =
    input.continuation?.retain && keepable ? { runId, runDir: paths.root } : null;
  return {
    envelope: (wsm: WorkspaceManager, opts: CreateEnvelopeOptions) =>
      candidateEnvelope(wsm, holder, holder ? (input.continuation?.adopt ?? null) : null, opts),
    settle: (
      wsm: WorkspaceManager,
      env: WorkspaceEnvelope,
      runs: readonly (CandidateRun | undefined)[],
    ) =>
      settleCandidateEnvelope(wsm, env, {
        runs,
        signal: input.signal,
        attemptsDir: paths.attemptsDir,
        log,
      }),
  };
}

/**
 * The candidate's envelope: the predecessor's retained envelope when `adopt`
 * hands one over (adoption transfers custody, never deletes), else a new one —
 * with `live` custody when `holder` says this run may keep it.
 */
async function candidateEnvelope(
  wsm: WorkspaceManager,
  holder: EnvelopeHolder | null,
  adopt: EnvelopeCustody | null,
  opts: CreateEnvelopeOptions,
): Promise<WorkspaceEnvelope> {
  if (!holder || opts.inPlace || opts.workspaceKind === "directory") return wsm.create(opts);
  if (adopt) return adoptRetainedEnvelope(adopt, holder);
  return wsm.create({ ...opts, custody: holder });
}

/** Why the candidate's work is unfinished (null = unfinished, cause not known
 * at this layer), or undefined when it finished. */
function unfinishedCause(
  run: CandidateRun | undefined,
  signal: AbortSignal | undefined,
): ResumableCause | null | undefined {
  if (signal?.aborted) return signal.reason === "wall_clock_exceeded" ? "wall_clock" : "cancelled";
  if (!run || run.errored) return null;
  const state = run.telemetry.outcome?.workState?.state;
  if (state === "needs_input") return "input_required";
  return state === "incomplete" ? null : undefined;
}

async function worthKeeping(
  env: WorkspaceEnvelope,
  run: CandidateRun | undefined,
  attemptsDir: string,
): Promise<boolean> {
  if (run && run.diff.trim().length > 0) return true;
  const attempts = new Set([env.attempt_id, ...(run ? [run.attemptId] : [])]);
  if ([...attempts].some((id) => existsSync(sessionCapsuleFile(join(attemptsDir, id))))) {
    return true;
  }
  return (await envelopeTreeChanged(env)) === true;
}

/**
 * End of a candidate: keep or dispose its envelope. Only an envelope under
 * this run's `live` custody can be kept; everything else is disposed exactly
 * as before. Keeping is durable before the run's terminal is reported and is
 * disclosed with a `workspace.retained` event (disk use measured once).
 */
async function settleCandidateEnvelope(
  wsm: WorkspaceManager,
  env: WorkspaceEnvelope,
  ctx: {
    runs: readonly (CandidateRun | undefined)[];
    signal?: AbortSignal;
    attemptsDir: string;
    log?: EventLog;
  },
): Promise<void> {
  const custody = readEnvelopeCustody(envelopeBaseOf(env));
  if (custody?.state !== "live" || custody.envelope.id !== env.id) return wsm.dispose(env);
  const run = ctx.runs.find((candidate) => candidate?.reviewCwd === env.worktree_path);
  const cause = unfinishedCause(run, ctx.signal);
  if (cause === undefined || !(await worthKeeping(env, run, ctx.attemptsDir))) {
    return wsm.dispose(env);
  }
  const holder = { runId: custody.holder_run_id, runDir: custody.holder_run_dir };
  const retained = retainForContinuation(env, holder, cause);
  ctx.log?.emit("workspace.retained", {
    attempt_id: run?.attemptId ?? env.attempt_id,
    root: env.worktree_path,
    cause,
    bytes: retained.bytes,
  });
}
