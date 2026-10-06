import { describe, expect, it } from "vitest";
import {
  run,
  seedSession,
  crash,
  limit,
  fileStoreContinuity,
} from "./inrun-continuity.test-support.js";

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

describe("thread publication and disclosure", () => {
  it.each(["agent", "ask"] as const)(
    "%s never publishes a stranger or retains its later events",
    async (mode) => {
      const observed: string[] = [];
      const o = await run({
        mode,
        profiles: ["a"],
        input: { threadId: "thread-fixture", onSessionObserved: (_h, id) => observed.push(id) },
        script: function* ({ emit, spec, tryOfProfile }) {
          if (tryOfProfile === 1) {
            seedSession(spec.cwd, "a", "sid-good");
            yield emit({ type: "started", payload: { native_session_id: "sid-good" } });
            yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
            yield emit({ type: "message", text: "first try finding" });
            yield* crash(emit);
          } else if (tryOfProfile === 2) {
            yield emit({ type: "message", text: "stranger before handshake" });
            yield emit({ type: "started", payload: { native_session_id: "sid-stranger" } });
            yield emit({ type: "message", text: "stranger after handshake" });
            yield emit({ type: "tool_call", tool: { name: "StrangerTool", kind: "command" } });
          } else {
            yield emit({ type: "started", payload: { native_session_id: "sid-packet" } });
            yield emit({ type: "message", text: "finished", final: true });
          }
          yield emit({ type: "completed" });
        },
      });
      expect(o.spawns).toHaveLength(3);
      expect(observed).toEqual(["sid-good"]);
      expect(o.spawns[2]!.prompt).toContain("first try finding");
      expect(o.spawns[2]!.prompt).not.toContain("stranger");
      expect(o.spawns[2]!.prompt).not.toContain("StrangerTool");
      expect(
        o.events.some((e) => JSON.stringify(e.payload).includes("stranger after handshake")),
      ).toBe(false);
    },
  );

  it.each(["agent", "ask"] as const)(
    "%s discloses a packet hop and preserves the previous lane binding",
    async (mode) => {
      const observed: string[] = [];
      const disclosures: unknown[] = [];
      const o = await run({
        mode,
        profiles: ["a", "b"],
        continuity: null,
        input: {
          threadId: "thread-fixture",
          threadContinuity: {
            turnId: "turn-fixture",
            profileId: null,
            priorTurns: [],
            laneCheckpoints: [],
          },
          onSessionObserved: (_h, id) => observed.push(id),
          onContinuityResolved: (_turn, disclosure) => disclosures.push(disclosure),
        },
        script: function* ({ profile, emit }) {
          yield emit({ type: "started", payload: { native_session_id: `sid-${profile}` } });
          if (profile === "a") {
            yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
            yield* limit(emit);
          } else {
            yield emit({ type: "message", text: "finished", final: true });
            yield emit({ type: "completed" });
          }
        },
      });
      expect(o.result.lifecycle).toBe("succeeded");
      expect(observed).toEqual(["sid-a"]);
      expect(disclosures.at(-1)).toMatchObject({
        kind: "packet",
        laneSwitchedFrom: { harness: "fake", profileId: "a" },
      });
      expect(o.events.filter((e) => e.type === "session.continuity").at(-1)?.payload).toMatchObject(
        { kind: "packet", lane_switched_from: { harness: "fake", profileId: "a" } },
      );
    },
  );
});

it("a rejected move's final thread disclosure is packet, and neither rejected nor packet sessions are published", async () => {
  const observed: string[] = [];
  const disclosures: unknown[] = [];
  const o = await run({
    mode: "ask",
    profiles: ["a", "b"],
    continuity: fileStoreContinuity({
      rejectsCarriedState: (ev) => ev.payload?.["code"] === "fixture_rejected",
    }),
    input: {
      threadId: "thread-fixture",
      threadContinuity: {
        turnId: "turn-fixture",
        profileId: null,
        priorTurns: [],
        laneCheckpoints: [],
      },
      onSessionObserved: (_h, id) => observed.push(id),
      onContinuityResolved: (_turn, disclosure) => disclosures.push(disclosure),
    },
    script: function* ({ profile, tryOfProfile, spec, emit }) {
      if (profile === "a") {
        seedSession(spec.cwd, "a", "sid-original");
        yield emit({ type: "started", payload: { native_session_id: "sid-original" } });
        yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
        yield* limit(emit);
      } else if (tryOfProfile === 1) {
        yield emit({ type: "started", payload: { native_session_id: "sid-stranger" } });
      } else {
        yield emit({ type: "started", payload: { native_session_id: "sid-packet" } });
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      }
    },
  });
  expect(o.result.lifecycle).toBe("succeeded");
  expect(observed).toEqual(["sid-original"]);
  expect(disclosures.slice(-2)).toMatchObject([
    { kind: "native_resume", laneSwitchedFrom: { profileId: "a" } },
    { kind: "packet", laneSwitchedFrom: { profileId: "a" } },
  ]);
});
