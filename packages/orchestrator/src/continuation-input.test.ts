import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { writeContinuationSources } from "@claudexor/workspace";
import { unconfirmedContinuationInputs } from "./continuation-input.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("continuation caller delivery", () => {
  it.each(["unstarted", "mismatch_before_effects", "matched_before_effects"])(
    "carries unconfirmed caller text (%s)",
    (identity) => {
      const runDir = mkdtempSync(join(tmpdir(), "cx-continuation-input-"));
      roots.push(runDir);
      writeContinuationSources(runDir, [
        { runId: "run-a", runDir: join(runDir, "a"), state: "failed" },
      ]);
      const rows = [
        { type: "run.created", payload: { prompt: "Keep the existing public interface" } },
        ...(identity === "unstarted"
          ? []
          : [{ type: "harness.event", payload: { type: "started", attempt_id: "a01" } }]),
        {
          type: "run.continuity",
          payload: {
            receipt: {
              tryIndex: 0,
              attemptId: "a01",
              carrier: "native",
              cause: "transport",
              from: { runId: "run-a", attemptId: "a01", profileId: null },
              to: { profileId: null },
              workspace: "same_root",
              memory: "full",
              instructions: "as_sent",
              reingestedTokens: null,
              observedModel: null,
              modelMismatch: null,
              identityCheck: identity === "unstarted" ? "not_applicable" : identity,
              inputDelivery: "confirmed",
            },
          },
        },
      ];
      writeFileSync(
        join(runDir, "events.jsonl"),
        rows
          .map((row, seq) =>
            JSON.stringify({
              seq: seq + 1,
              run_id: "run-b",
              task_id: "task-b",
              ts: new Date().toISOString(),
              ...row,
            }),
          )
          .join("\n") + "\n",
      );
      expect(unconfirmedContinuationInputs([{ runId: "run-b", runDir, state: "failed" }])).toBe(
        identity === "matched_before_effects" ? null : "Keep the existing public interface",
      );
    },
  );
});
