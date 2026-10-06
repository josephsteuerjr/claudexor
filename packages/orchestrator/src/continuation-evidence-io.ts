/**
 * Evidence-index collector — the I/O half of `continuation-evidence.ts`.
 *
 * Reads the predecessor's durable record (the run's `events.jsonl` and, for
 * read-only attempts, the attempt's own `events.jsonl`) into the pure
 * builder's input: tool calls paired by try/session and typed use id (legacy
 * results without an id close the oldest open call), and admitted steering
 * messages with their delivery status (`message.delivered` = confirmed; an
 * `accepted` row with no closing = uncertain; refused = not sent), and the
 * absolute artifact paths. Never throws: unreadable evidence yields an empty
 * index section, never a failed continuation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResumableCause } from "@claudexor/schema";
import type {
  EvidenceIndexInput,
  EvidenceIndexSources,
  EvidenceSteering,
  EvidenceToolCall,
} from "./continuation-evidence.js";

type Row = Record<string, unknown>;

function readRows(path: string): Row[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return parsed && typeof parsed === "object" ? [parsed as Row] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function asRow(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}

/** The attempt's harness events: attempt-local log first, else the run log filtered by attempt. */
function attemptHarnessEvents(runDir: string, attemptId: string): Row[] {
  const own = readRows(join(runDir, "attempts", attemptId, "events.jsonl"));
  if (own.length > 0) return own;
  return readRows(join(runDir, "events.jsonl")).flatMap((row) => {
    const payload = asRow(row["payload"]);
    return row["type"] === "harness.event" && payload && payload["attempt_id"] === attemptId
      ? [payload]
      : [];
  });
}

/** Pair typed use ids within a native try; ambiguous ids remain unresolved. */
export function toolCallIndex(events: readonly Row[]): EvidenceToolCall[] {
  const calls: { call: EvidenceToolCall; session: unknown; id: string | null }[] = [];
  for (const ev of events) {
    const tool = asRow(ev["tool"]);
    const id = typeof tool?.["use_id"] === "string" ? tool["use_id"] : null;
    const target = typeof tool?.["target"] === "string" ? tool["target"] : null;
    // A file edit the vendor reports twice (codex: started, then completed) is
    // one call per path; the later frame for the same path is the completion
    // (one codex item may carry several paths under one id).
    const sameEdit =
      ev["type"] === "file_change" && id !== null
        ? calls.filter(
            (entry) =>
              entry.id === id &&
              entry.session === ev["session_id"] &&
              (target === null || entry.call.target === target),
          )
        : [];
    if (sameEdit.length > 0) {
      const open = sameEdit.find((entry) => !entry.call.resolved);
      if (open) open.call.resolved = true;
    } else if (ev["type"] === "tool_call" || (ev["type"] === "file_change" && tool)) {
      const name =
        typeof tool?.["name"] === "string" && tool["name"].trim()
          ? tool["name"]
          : typeof ev["text"] === "string" && ev["text"].trim()
            ? ev["text"].split("\n")[0]!.slice(0, 80)
            : "tool";
      calls.push({ call: { name, target, resolved: false }, session: ev["session_id"], id });
    } else if (ev["type"] === "tool_result") {
      const open = calls.filter(
        (entry) => !entry.call.resolved && entry.session === ev["session_id"],
      );
      const matched = id === null ? open.slice(0, 1) : open.filter((entry) => entry.id === id);
      if (matched.length === 1) matched[0]!.call.resolved = true;
    }
  }
  return calls.map((entry) => entry.call);
}

/** Admitted steering messages of a run, with delivery status, in admission order. */
export function steeringFromRunLog(runDir: string, attemptId?: string): EvidenceSteering[] {
  const byId = new Map<string, EvidenceSteering & { refused: boolean }>();
  for (const row of readRows(join(runDir, "events.jsonl"))) {
    const payload = asRow(row["payload"]);
    const rowAttempt = payload?.["attempt_id"] ?? row["attempt_id"];
    if (attemptId !== undefined && typeof rowAttempt === "string" && rowAttempt !== attemptId)
      continue;
    const id = typeof payload?.["message_id"] === "string" ? payload["message_id"] : null;
    const text = typeof payload?.["text"] === "string" ? payload["text"] : null;
    if (!id || text === null) continue;
    const entry = byId.get(id) ?? { text, delivery: "uncertain" as const, refused: false };
    if (row["type"] === "message.accepted") byId.set(id, entry);
    else if (row["type"] === "message.delivered") byId.set(id, { ...entry, delivery: "confirmed" });
    else if (row["type"] === "message.refused") byId.set(id, { ...entry, refused: true });
  }
  return [...byId.values()]
    .filter((entry) => !entry.refused)
    .map(({ text, delivery }) => ({ text, delivery }));
}

/** Resolve the pure builder's input from the run dir plus the loop's in-memory facts. */
export function collectEvidenceIndexInput(
  sources: EvidenceIndexSources,
  extras: {
    cause: ResumableCause;
    retainedOutput: string;
    diffStat: string | null;
    completed?: boolean;
  },
): EvidenceIndexInput {
  const attemptDir = join(sources.runDir, "attempts", sources.attemptId);
  const eventsLog = join(sources.runDir, "events.jsonl");
  const attemptPatch = join(attemptDir, "patch.diff");
  const patch = existsSync(attemptPatch)
    ? attemptPatch
    : join(sources.runDir, "final", "patch.diff");
  const current: EvidenceIndexInput = {
    cause: extras.cause,
    ...(extras.completed ? { completed: true } : {}),
    workOrder: sources.workOrder,
    steering:
      sources.steering.length > 0
        ? sources.steering
        : steeringFromRunLog(sources.runDir, sources.attemptId),
    retainedOutput: extras.retainedOutput,
    toolCalls: toolCallIndex(attemptHarnessEvents(sources.runDir, sources.attemptId)),
    diffStat: extras.diffStat,
    artifacts: {
      eventsLog: existsSync(eventsLog) ? eventsLog : null,
      attemptDir: existsSync(attemptDir) ? attemptDir : null,
      patch: existsSync(patch) ? patch : null,
    },
  };
  const preceding =
    sources.predecessors?.map((source) =>
      collectEvidenceIndexInput(source, {
        cause: extras.cause,
        retainedOutput: source.retainedOutput,
        diffStat: source.diffStat,
      }),
    ) ?? [];
  if (preceding.length === 0) return current;
  const all = [...preceding, current];
  return {
    ...current,
    steering: all.flatMap((input) => input.steering),
    retainedOutput: all
      .map((input) => input.retainedOutput)
      .filter(Boolean)
      .join("\n\n"),
    toolCalls: all.flatMap((input) => input.toolCalls),
    diffStat:
      [...new Set(all.flatMap((input) => input.diffStat?.split("\n") ?? []))].join("\n") || null,
    predecessorArtifacts: preceding.map((input) => input.artifacts),
  };
}

/** `git diff`-style file list from a unified diff: one line per changed path. */
export function diffStatFromPatch(diff: string): string | null {
  if (!diff.trim()) return null;
  const files = diff
    .split("\n")
    .filter((line) => line.startsWith("diff --git "))
    .map((line) => line.slice("diff --git ".length).split(" b/").pop() ?? line)
    .filter((path) => path.trim());
  return files.length ? files.map((path) => `- ${path}`).join("\n") : null;
}
