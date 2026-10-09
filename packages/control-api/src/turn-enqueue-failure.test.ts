import { describe, expect, it } from "vitest";
import { recordTurnEnqueueFailure } from "./thread-turn-problems.js";

// The recorder shared by direct POST /runs with a threadId and rerun_with_feedback:
// a lost answer (retryable transport failure) may hide an accepted job, so it stays
// retryable for the retry endpoint to resolve from the journal; a typed refusal and
// an untyped throw recorded no job.
describe("recordTurnEnqueueFailure", () => {
  it("keeps a lost answer retryable and a refusal final", () => {
    const recorded: boolean[] = [];
    const record = (err: unknown) =>
      recordTurnEnqueueFailure((_id, problem) => recorded.push(problem.retryable), "tn-1", err)
        .retryable;
    const lost = Object.assign(new Error("daemon RPC timeout (claudexor.enqueue)"), {
      code: "daemon_busy",
      status: 503,
      retryable: true,
    });
    const refused = Object.assign(new Error("project not registered"), {
      code: "project_not_registered",
      status: 409,
      retryable: false,
    });
    expect(record(lost)).toBe(true);
    expect(record(refused)).toBe(false);
    expect(record(new Error("socket gone"))).toBe(false);
    expect(recorded).toEqual([true, false, false]);
  });
});
