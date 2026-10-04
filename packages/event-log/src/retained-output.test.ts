import { describe, expect, it } from "vitest";
import { OutputReadyPayload, type RunEvent } from "@claudexor/schema";
import { retainedOutput } from "./retained-output.js";

function event(seq: number, text: string, extra: Record<string, unknown> = {}): RunEvent {
  return {
    seq,
    ts: "2026-10-04T00:00:00.000Z",
    run_id: "run-1",
    task_id: "task-1",
    type: "harness.event",
    payload: {
      attempt_id: "a01",
      harness_id: "cursor",
      session_id: "try-1",
      type: "message",
      text,
      ...extra,
    },
  };
}

describe("retained output evidence", () => {
  it("keeps delta-only Markdown and a late acknowledgement without promoting either", () => {
    const text = retainedOutput([
      event(1, "# Review\n\n- ", { payload: { delta: true } }),
      event(2, "finding\n", { payload: { delta: true } }),
      event(3, "Tests already included.", { final: true }),
    ]);
    expect(text).toContain("# Review\n\n- finding\n");
    expect(text).toContain("Tests already included.");
    expect(text).toContain("not a completion verdict");
  });

  it("collapses exact adjacent flushes but preserves a different or repeated later message", () => {
    const text = retainedOutput([
      event(1, "Hello ", { payload: { delta: true } }),
      event(2, "world", { payload: { delta: true } }),
      event(3, "Hello world", { payload: { buffered: true } }),
      event(4, "Hello world"),
      event(5, "Hello world", { final: true }),
      event(6, "different"),
      event(7, "Hello world"),
    ]);
    expect(text?.match(/Hello world/g)).toHaveLength(2);
    expect(text).toContain("different");
  });

  it("does not duplicate a final-only success but preserves it on failure", () => {
    const events = [event(1, "Normal final", { final: true })];
    expect(retainedOutput(events, 0, true)).toBeNull();
    expect(retainedOutput(events)).toContain("Normal final");
    expect(retainedOutput([event(0, "Earlier draft"), ...events], 0, true)).toContain(
      "Earlier draft",
    );
  });

  it("exposes captured media through attempt-scoped artifact references", () => {
    const output = {
      ...event(2, ""),
      type: "output.ready" as const,
      payload: OutputReadyPayload.parse({
        kind: "artifact",
        state: "diagnostic",
        path: "attempts/a01/produced/image one.png",
      }),
    };
    const text = retainedOutput([event(1, "![Image](image one.png)"), output]);
    expect(text).toContain("../attempts/a01/produced/image%20one.png");
    expect(text).toContain("Captured files · attempt a01");
    expect(
      retainedOutput([{ ...output, payload: { kind: "artifact", path: "screenshot.png" } }]),
    ).toBeNull();
  });

  it("retains a buffered-only frame, all physical tries and interleaved candidates", () => {
    const text = retainedOutput([
      event(1, "first", { payload: { buffered: true } }),
      event(2, "sibling", { attempt_id: "a02", session_id: "try-2" }),
      event(3, "retry", { session_id: "try-3", final: true }),
    ]);
    for (const expected of ["first", "sibling", "retry", "try-1", "try-2", "try-3"])
      expect(text).toContain(expected);
  });

  it("does not retain reasoning, tool output, status, prompt echo or auth disclosures as an answer", () => {
    expect(
      retainedOutput([
        event(1, "thinking secret", { type: "thinking" }),
        event(2, "tool result", { type: "tool_result" }),
        event(3, "error status", { type: "status" }),
        event(4, "route switched", { payload: { auth_switched: true } }),
        event(5, "   "),
      ]),
    ).toBeNull();
  });

  it("keeps text beyond display budgets and discloses damaged source records", () => {
    const text = retainedOutput(
      Array.from({ length: 10001 }, (_, i) =>
        event(i + 1, i === 10000 ? "END" : "x", { payload: { delta: true } }),
      ),
      1,
    );
    expect(text).toContain("x".repeat(10000) + "END");
    expect(text).toContain("1 unreadable record");
  });

  it("stops at the committed terminal instead of incorporating later audit data", () => {
    const terminal = { ...event(2, ""), type: "run.failed" as const, payload: {} };
    const text = retainedOutput([event(1, "before"), terminal, event(3, "after")]);
    expect(text).toContain("before");
    expect(text).not.toContain("after");
  });
});
