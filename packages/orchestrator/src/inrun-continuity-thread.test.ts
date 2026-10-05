import { describe, expect, it } from "vitest";
import { run } from "./inrun-continuity.test-support.js";

describe("thread continuity across in-run tries", () => {
  it.each(["agent", "ask"] as const)(
    "%s retries a pre-progress transient on the thread's session",
    async (mode) => {
      const observed: string[] = [];
      const o = await run({
        mode,
        profiles: ["a"],
        input: {
          threadId: "thread-fixture",
          resumeSessions: { fake: { sessionId: "sid-thread", profileId: "a" } },
          onSessionObserved: (_harness, id) => observed.push(id),
        },
        script: function* ({ emit, resume, tryOfProfile }) {
          yield emit({ type: "started", payload: { native_session_id: resume ?? "sid-new" } });
          if (tryOfProfile === 1) {
            yield emit({
              type: "error",
              error: "connection reset",
              transient: { kind: "network", retry_delay_ms: 0 },
            });
          } else {
            yield emit({ type: "message", text: "continued thread", final: true });
          }
          yield emit({ type: "completed" });
        },
      });
      expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
      expect(o.spawns.map((s) => s.resume)).toEqual(["sid-thread", "sid-thread"]);
      expect(observed).toEqual(["sid-thread", "sid-thread"]);
    },
  );
});
