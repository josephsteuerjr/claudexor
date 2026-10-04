import { RETAINED_OUTPUT_PATH, readRunEvents, writeRetainedOutput } from "@claudexor/event-log";
import { safeArtifactPath } from "./artifact-paths.js";
import { readRunTombstone } from "./retention.js";
import type { DaemonRunRecord } from "./run-record.js";

/** Addressed recovery only. Lists/startup never scan historical run logs. */
export function recoverInterruptedOutput(rec: DaemonRunRecord): string | null {
  if (rec.state !== "interrupted" || !rec.runDir || readRunTombstone(rec.runDir)) return null;
  if (safeArtifactPath(rec.runDir, RETAINED_OUTPUT_PATH)) return null;
  const eventsPath = safeArtifactPath(rec.runDir, "events.jsonl");
  if (!eventsPath || !safeArtifactPath(rec.runDir, "final")) return null;
  // The detail timeline may be a bounded tail; recovery needs the complete
  // surviving stream once, after which ordinary artifact reads suffice.
  const source = readRunEvents(eventsPath);
  if (!source.events.every((event) => event.run_id === (rec.runId ?? rec.id))) return null;
  if (
    source.events.some((event) =>
      ["run.completed", "run.failed", "run.blocked"].includes(event.type),
    )
  )
    return null;
  try {
    writeRetainedOutput(rec.runDir, source);
    return null;
  } catch {
    return "Interrupted output could not be materialized; the original run state is unchanged. Inspect events.jsonl.";
  }
}
