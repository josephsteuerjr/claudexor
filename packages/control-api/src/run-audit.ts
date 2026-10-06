import { join } from "node:path";
import { appendRunEvent } from "@claudexor/event-log";
import type { RunEventType } from "@claudexor/schema";
import type { DaemonRunRecord } from "./run-record.js";

/** Append a control-verb audit event to a run's own event log (best-effort). */
export function appendRunAuditEvent(
  rec: DaemonRunRecord,
  type: RunEventType,
  payload: Record<string, unknown>,
): void {
  if (!rec.runDir) return;
  try {
    // Single-counter invariant: while the run is active its EventLog owns the
    // seq space, so audit records MUST route through it (appendRunEvent does;
    // file-tail stamping only applies once the run is terminal). A tail-read
    // here would duplicate ids and break SSE Last-Event-ID resume.
    appendRunEvent(
      join(rec.runDir, "events.jsonl"),
      rec.runId ?? rec.id,
      rec.taskId ?? "unknown",
      type,
      payload,
    );
  } catch {
    /* audit append must not change control behavior */
  }
}
