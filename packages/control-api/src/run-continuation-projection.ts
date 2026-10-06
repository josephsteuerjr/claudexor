/**
 * Run-status projection of the `continueFrom` chain: the terminal `resumable`
 * block (INTERFACES §2), the per-try `continuity` receipts (§3), the
 * predecessor link and a kept envelope's disk use. Projected verbatim from
 * engine artifacts; surfaces never re-derive these facts.
 *
 * `resumable` comes from `final/resumable.yaml` (written by the engine at its
 * terminal) with the CURRENT workspace overlaid: the envelope a run keeps
 * (custody `retained`) or, once a successor adopted it or the run was
 * discarded, none. A run the daemon found running at its restart never reached
 * an engine terminal: its block is derived here from the durable session
 * capsule and custody record (cause `host_restart`), so it can be continued.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRunEvents } from "@claudexor/event-log";
import {
  RunContinuityReceipt,
  RunResumable,
  SessionCapsule,
  type ControlRunSummary,
} from "@claudexor/schema";
import {
  readContinuationSources,
  retainedEnvelopeInChain,
  retainedEnvelopeOfRun,
} from "@claudexor/workspace";
import { safeReadStructuredArtifact } from "./run-artifact-read.js";
import { paramsRecord, type DaemonRunRecord } from "./run-record.js";
import { TERMINAL_STATES } from "./sse-shared.js";

/** Per-attempt capsule file the engine writes when a native session starts (orchestrator `session-capsule.ts`). */
const SESSION_CAPSULE_FILE = "session-capsule.json";

function newestCapsule(runDir: string): SessionCapsule | null {
  const attemptsDir = join(runDir, "attempts");
  if (!existsSync(attemptsDir)) return null;
  let newest: SessionCapsule | null = null;
  for (const attempt of readdirSync(attemptsDir)) {
    try {
      const parsed = SessionCapsule.safeParse(
        JSON.parse(readFileSync(join(attemptsDir, attempt, SESSION_CAPSULE_FILE), "utf8")),
      );
      if (parsed.success && (parsed.data.mtimeMs ?? 0) >= (newest?.mtimeMs ?? 0))
        newest = parsed.data;
    } catch {
      // No capsule in this attempt (or a torn one): nothing to resume there.
    }
  }
  return newest;
}

function inPlaceRoot(params: Record<string, unknown>): string | null {
  const execution = params["execution"] as Record<string, unknown> | undefined;
  if (execution?.["isolation"] !== "live") return null;
  const scope = params["scope"] as Record<string, unknown> | undefined;
  const root = execution["workspaceRoot"] ?? scope?.["root"];
  return typeof root === "string" ? root : null;
}

type Continuation = Pick<
  ControlRunSummary,
  "continueFrom" | "resumable" | "retainedEnvelope" | "continuity"
>;

/** The chain facts of one run; `events` (run detail) adds the per-try receipts. */
export function continuationSummary(
  rec: DaemonRunRecord,
  events?: readonly Record<string, unknown>[],
): Continuation {
  const params = paramsRecord(rec);
  const continueFrom = typeof params["continueFrom"] === "string" ? params["continueFrom"] : null;
  const continuity = events?.flatMap((event) => {
    if (event["type"] !== "run.continuity") return [];
    const payload = event["payload"] as Record<string, unknown> | undefined;
    const receipt = RunContinuityReceipt.safeParse(payload?.["receipt"]);
    return receipt.success ? [receipt.data] : [];
  });
  const base = { continueFrom, ...(continuity ? { continuity } : {}) };
  if (!rec.runDir || !TERMINAL_STATES.has(rec.state)) {
    return { ...base, resumable: null, retainedEnvelope: null };
  }
  const kept = retainedEnvelopeOfRun(rec.runDir, rec.runId ?? rec.id);
  const retainedEnvelope = kept
    ? {
        root: kept.envelope.worktree_path,
        bytes: kept.bytes,
        retainedAt: kept.retained_at ?? "",
        cause: kept.cause,
      }
    : null;
  const sources = readContinuationSources(rec.runDir);
  const available = kept ?? retainedEnvelopeInChain(sources);
  const keptWorkspace = available
    ? { kind: "retained_envelope" as const, root: available.envelope.worktree_path }
    : null;
  let written = safeReadStructuredArtifact(rec, "final/resumable.yaml", RunResumable);
  let capsule = newestCapsule(rec.runDir);
  let inherited = false;
  if (!written && !capsule && rec.state !== "succeeded") {
    for (const source of sources) {
      const ancestor = { ...source, id: source.runId };
      written = safeReadStructuredArtifact(ancestor, "final/resumable.yaml", RunResumable);
      capsule = newestCapsule(source.runDir);
      inherited =
        !!written ||
        !!capsule ||
        ["answer.md", "retained-output.md", "patch.diff"].some((file) =>
          existsSync(join(source.runDir, "final", file)),
        ) ||
        readRunEvents(join(source.runDir, "events.jsonl")).events.some(
          (event) =>
            event.type === "harness.event" &&
            ["tool_call", "file_change", "message"].includes(String(event.payload["type"])),
        );
      if (inherited) break;
    }
  }
  if (written) {
    const workspace =
      keptWorkspace ??
      (written.workspace.kind === "retained_envelope"
        ? { kind: "none" as const, root: null }
        : written.workspace);
    return { ...base, resumable: { ...written, workspace }, retainedEnvelope };
  }
  const restarted =
    rec.state === "interrupted" && !existsSync(join(rec.runDir, "final", "run_facts.yaml"));
  if (!restarted && !kept && !inherited) return { ...base, resumable: null, retainedEnvelope };
  const root = inPlaceRoot(params);
  return {
    ...base,
    retainedEnvelope,
    resumable: {
      cause: restarted ? "host_restart" : (kept?.cause ?? "other"),
      resetsAt: null,
      limitWindow: null,
      limitEvidence: null,
      // A fresh session briefed by the evidence index is always available; the
      // native session when its capsule survived.
      carriers: capsule ? ["native", "packet"] : ["packet"],
      limitCode: null,
      session: capsule
        ? {
            harness: capsule.harness,
            nativeSessionId: capsule.nativeSessionId,
            holderProfileId: capsule.holderProfileId,
          }
        : null,
      workspace:
        keptWorkspace ?? (root ? { kind: "in_place", root } : { kind: "none", root: null }),
    },
  };
}
