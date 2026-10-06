import { describe, expect, it } from "vitest";
import {
  run,
  seedSession,
  crash,
  limit,
  fileStoreContinuity,
} from "./inrun-continuity.test-support.js";

describe("attempt evidence and begun-try receipts", () => {
  it.each(["agent", "ask"] as const)(
    "%s retains earlier narration across a silent native rejection",
    async (mode) => {
      const o = await run({
        mode,
        profiles: ["a"],
        continuity: fileStoreContinuity({
          rejectsCarriedState: (ev) => ev.payload?.["code"] === "fixture_rejected",
        }),
        script: function* ({ emit, spec, tryOfProfile }) {
          if (tryOfProfile === 1) {
            seedSession(spec.cwd, "a", "sid-good");
            yield emit({ type: "started", payload: { native_session_id: "sid-good" } });
            yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
            yield emit({ type: "message", text: "earlier useful findings" });
            yield* crash(emit);
          } else if (tryOfProfile === 2) {
            yield emit({ type: "error", error: "rejected", payload: { code: "fixture_rejected" } });
          } else {
            yield emit({ type: "message", text: "finished", final: true });
          }
          yield emit({ type: "completed" });
        },
      });
      expect(o.spawns[2]!.prompt).toContain("earlier useful findings");
      expect(o.spawns[2]!.prompt).not.toContain("(no output retained)");
      expect(o.spawns[2]!.prompt).not.toContain(
        "The last instruction sent to the previous process may not have been delivered",
      );
    },
  );

  it("does not emit a receipt for a continuation cancelled during preparation", async () => {
    const stop = new AbortController();
    const store = fileStoreContinuity();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      input: { signal: stop.signal },
      continuity: {
        ...store,
        async move(...args) {
          const result = await store.move(...args);
          stop.abort("user_cancelled");
          return result;
        },
      },
      script: function* ({ spec, emit }) {
        seedSession(spec.cwd, "a", "sid-good");
        yield emit({
          type: "started",
          observed_model: "m1",
          payload: { native_session_id: "sid-good" },
        });
        yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
        yield* limit(emit);
      },
    });
    expect(o.result.lifecycle).toBe("cancelled");
    expect(o.spawns).toHaveLength(1);
    expect(o.receipts).toEqual([]);
  });
});

it("uncertain initial input quotes only the caller's work order", async () => {
  const o = await run({
    mode: "ask",
    profiles: ["a"],
    continuity: null,
    script: function* ({ tryOfProfile, emit }) {
      if (tryOfProfile === 1) {
        yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
        yield* crash(emit);
      } else {
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      }
    },
  });
  expect(o.spawns[1]!.prompt).toContain(
    "It was:\n\nWORK-ORDER-7f3a: build the dashboard\n\nReconcile",
  );
});
