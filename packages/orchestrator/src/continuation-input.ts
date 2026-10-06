/** Caller text of earlier continuations needs delivery proof, not merely a copied capsule. */
import { join } from "node:path";
import { readRunEvents } from "@claudexor/event-log";
import { RunContinuityReceipt, type ContinuationSources } from "@claudexor/schema";
import { readContinuationSources } from "@claudexor/workspace";

/** Reference only: the notice tells the next process to reconcile, never replay blindly. */
export function unconfirmedContinuationInputs(sources: ContinuationSources): string | null {
  const uncertain: string[] = [];
  for (const [index, source] of sources.entries()) {
    if (index === sources.length - 1 && readContinuationSources(source.runDir).length === 0)
      continue;
    const { events } = readRunEvents(join(source.runDir, "events.jsonl"));
    const text = events.find((event) => event.type === "run.created")?.payload["prompt"];
    if (typeof text !== "string" || !text.trim()) continue;
    const settled = events
      .map((event, index) => ({
        index,
        receipt:
          event.type === "run.continuity"
            ? RunContinuityReceipt.safeParse(event.payload["receipt"]).data
            : undefined,
      }))
      .find((entry) => entry.receipt?.tryIndex === 0);
    const receipt = settled?.receipt;
    // A mismatched handshake is not delivery. A missing receipt (including a crash
    // during the first try) leaves delivery unproved even if a session file exists.
    const delivered =
      receipt &&
      !receipt.identityCheck.startsWith("mismatch") &&
      events.some(
        (event, index) =>
          event.type === "harness.event" &&
          index < settled!.index &&
          event.payload["attempt_id"] === receipt.attemptId &&
          event.payload["type"] === "started",
      );
    if (!delivered) uncertain.push(text.trim());
  }
  return uncertain.length ? uncertain.reverse().join("\n\n") : null;
}
