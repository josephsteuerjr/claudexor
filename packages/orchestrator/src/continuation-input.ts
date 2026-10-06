/** Caller text of earlier continuations needs delivery proof, not merely a copied capsule. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readRunEvents } from "@claudexor/event-log";
import { RunContinuityReceipt, type ContinuationSources } from "@claudexor/schema";
import { readContinuationSources } from "@claudexor/workspace";
import { readTextSafe } from "@claudexor/util";
import { steeringFromRunLog } from "./continuation-evidence-io.js";

export interface UncertainInput {
  text: string;
  runDir: string;
}

/** Reuse complete durable context; only missing text needs a new context file. */
export function completeInputPath(input: UncertainInput, currentRunDir: string): string {
  for (const runDir of [input.runDir, currentRunDir]) {
    const path = resolve(runDir, "context", "work-order.md");
    if (readTextSafe(path)?.includes(input.text)) return path;
  }
  const digest = createHash("sha256").update(input.text).digest("hex");
  const path = resolve(currentRunDir, "context", `uncertain-input-${digest}.md`);
  if (readTextSafe(path) !== input.text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, input.text);
  }
  return path;
}

/** Reference only: the notice tells the next process to reconcile, never replay blindly. */
export function unconfirmedContinuationInputs(sources: ContinuationSources): UncertainInput[] {
  const uncertain: UncertainInput[] = [];
  // A newer run of the chain whose process started was handed these inputs in its notice.
  let newerStarted = false;
  for (const [index, source] of sources.entries()) {
    const { events } = readRunEvents(join(source.runDir, "events.jsonl"));
    const startedHere = events.some(
      (event) => event.type === "harness.event" && event.payload["type"] === "started",
    );
    // A stopped run's admitted steering without delivery proof is newer than its caller text.
    // The live run's own steering is read per attempt by `uncertainInputFor`.
    if (!newerStarted && source.state !== "running") {
      uncertain.push(
        ...steeringFromRunLog(source.runDir)
          .filter((message) => message.delivery === "uncertain")
          .reverse()
          .map(({ text }) => ({ text, runDir: source.runDir })),
      );
    }
    newerStarted ||= startedHere;
    if (index === sources.length - 1 && readContinuationSources(source.runDir).length === 0)
      continue;
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
    if (!delivered) uncertain.push({ text, runDir: source.runDir });
  }
  return uncertain;
}
