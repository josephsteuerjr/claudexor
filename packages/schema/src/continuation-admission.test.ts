import { describe, expect, it } from "vitest";
import {
  continuationRefusal,
  continuationRefusalError,
  type ContinuationRecord,
} from "./continuation-admission.js";

const done = (id: string, runId: string, params: unknown = {}): ContinuationRecord => ({
  id,
  runId,
  state: "failed",
  params,
});

describe("continuationRefusal (INTERFACES §1 admission)", () => {
  it("passes requests that continue nothing", () => {
    expect(continuationRefusal({ prompt: "x" }, [])).toBeNull();
  });

  it("admits a terminal predecessor named by run id or job id", () => {
    const records = [done("job-p", "run-p")];
    expect(continuationRefusal({ continueFrom: "run-p" }, records)).toBeNull();
    expect(continuationRefusal({ continueFrom: "job-p" }, records)).toBeNull();
  });

  it("refuses threadId on the request and a thread-turn predecessor", () => {
    const records = [done("job-p", "run-p"), done("job-t", "run-t", { threadId: "th-1" })];
    expect(continuationRefusal({ continueFrom: "run-p", threadId: "th-1" }, records)).toMatchObject(
      { code: "continue_from_with_thread", status: 400 },
    );
    expect(continuationRefusal({ continueFrom: "run-t" }, records)).toMatchObject({
      code: "continue_from_with_thread",
      status: 400,
      context: { runId: "run-t" },
    });
  });

  it("refuses unknown ids and jobs that never started a run (foreign daemons included)", () => {
    const records = [{ id: "job-refused", state: "failed", params: {} }];
    for (const id of ["run-elsewhere", "job-refused"]) {
      expect(continuationRefusal({ continueFrom: id }, records)).toMatchObject({
        code: "predecessor_unknown",
        status: 404,
      });
    }
  });

  it("answers a still-queued job (no run bound yet) as live, not unknown", () => {
    const records = [{ id: "job-q", state: "queued", params: {} }];
    expect(continuationRefusal({ continueFrom: "job-q" }, records)).toMatchObject({
      code: "predecessor_live",
      status: 409,
      context: { runId: "job-q", state: "queued" },
    });
  });

  it("refuses a live predecessor with its state", () => {
    for (const state of ["queued", "running"]) {
      const records = [{ id: "job-p", runId: "run-p", state, params: {} }];
      expect(continuationRefusal({ continueFrom: "run-p" }, records)).toMatchObject({
        code: "predecessor_live",
        status: 409,
        context: { runId: "run-p", state },
      });
    }
  });

  it("allows one successor and names the chain head to everyone after it", () => {
    const records: ContinuationRecord[] = [
      done("job-a", "run-a"),
      // B ran and failed: a claimed successor that fails stays the head.
      done("job-b", "run-b", { continueFrom: "run-a" }),
      // C is still queued (no run id yet): its job id is the handle.
      { id: "job-c", state: "queued", params: { continueFrom: "job-b" } },
    ];
    expect(continuationRefusal({ continueFrom: "run-a" }, records)).toMatchObject({
      code: "continuation_superseded",
      status: 409,
      context: { runId: "run-a", head: "job-c" },
    });
    expect(continuationRefusal({ continueFrom: "job-b" }, records)).toMatchObject({
      code: "continuation_superseded",
      context: { runId: "run-b", head: "job-c" },
    });
  });

  it("releases the claim of a successor refused before its run started", () => {
    const records: ContinuationRecord[] = [
      done("job-a", "run-a"),
      { id: "job-b", state: "failed", params: { continueFrom: "run-a" } },
    ];
    expect(continuationRefusal({ continueFrom: "run-a" }, records)).toBeNull();
  });

  it("refuses run shapes whose first try cannot carry the predecessor's work", () => {
    const records = [done("job-p", "run-p")];
    for (const shape of [
      { mode: "plan" },
      { n: 3 },
      { attempts: 2 },
      { untilClean: true },
      { mode: "ask", deepScan: true },
      { mode: "plan", council: true },
    ]) {
      expect(continuationRefusal({ continueFrom: "run-p", ...shape }, records)).toMatchObject({
        code: "continue_from_unsupported",
        status: 400,
      });
    }
    for (const shape of [{}, { mode: "agent", n: 1 }, { mode: "ask" }, { create: true }]) {
      expect(continuationRefusal({ continueFrom: "run-p", ...shape }, records)).toBeNull();
    }
  });

  it("projects a refusal as a typed problem error", () => {
    const refusal = continuationRefusal({ continueFrom: "run-x" }, []);
    expect(continuationRefusalError(refusal!)).toMatchObject({
      code: "predecessor_unknown",
      status: 404,
      retryable: false,
      requiredActions: [expect.any(String)],
    });
  });
});
