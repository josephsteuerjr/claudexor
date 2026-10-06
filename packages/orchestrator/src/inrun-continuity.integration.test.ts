/** In-run continuation through the real orchestrator with an offline fake harness. */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTINUITY_IDENTITY_MISMATCH_CODE } from "@claudexor/core";
import {
  run,
  seedSession,
  fileStoreContinuity,
  limit,
  crash,
  RESET,
} from "./inrun-continuity.test-support.js";

describe("in-run continuation (agent lane, in place)", () => {
  it("edit → typed limit → hop: the next account resumes the MOVED session with the notice, not the work order; one coherent patch", async () => {
    let root = "";
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      script: function* ({ profile, spec, emit, resume }) {
        if (profile === "a") {
          root = join(spec.cwd);
          seedSession(root, "a", "sid-A");
          yield emit({
            type: "started",
            observed_model: "m1",
            payload: { native_session_id: "sid-A" },
          });
          writeFileSync(join(spec.cwd, "part1.txt"), "first half\n");
          yield emit({ type: "file_change", payload: { path: "part1.txt" } });
          yield* limit(emit);
          return;
        }
        // b resumes the moved session: same id, the notice, never the work order.
        expect(resume).toBe("sid-A");
        yield emit({
          type: "started",
          observed_model: "m1",
          payload: { native_session_id: "sid-A" },
        });
        writeFileSync(join(spec.cwd, "part2.txt"), "second half\n");
        yield emit({ type: "file_change", payload: { path: "part2.txt" } });
        yield emit({ type: "message", text: "Done: both parts.", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    expect(o.spawns.map((s) => [s.profile, s.resume])).toEqual([
      ["a", null],
      ["b", "sid-A"],
    ]);
    expect(o.spawns[1]!.prompt).toContain(
      "The previous process stopped (a usage limit on the previous account)",
    );
    expect(o.spawns[1]!.prompt).not.toContain("WORK-ORDER-7f3a");
    // The session file moved: it is in b's store and gone from a's.
    expect(existsSync(join(o.stores["b"]!, "sessions", "sid-A.jsonl"))).toBe(true);
    expect(existsSync(join(o.stores["a"]!, "sessions", "sid-A.jsonl"))).toBe(false);
    expect(o.rotated).toHaveLength(1);
    expect(o.rotated[0]).toMatchObject({
      from_profile_id: "a",
      to_profile_id: "b",
      reason: "vendor_limit_rejected",
    });
    expect(o.receipts).toHaveLength(1);
    expect(o.receipts[0]).toMatchObject({
      tryIndex: 1,
      carrier: "native_moved",
      cause: "vendor_limit",
      from: { profileId: "a" },
      to: { profileId: "b" },
      memory: "full",
      instructions: "as_sent",
      workspace: "same_root",
      observedModel: "m1",
      modelMismatch: false,
      identityCheck: "matched_before_effects",
      inputDelivery: "confirmed",
    });
    // One coherent patch: both halves from one attempt.
    expect(existsSync(join(root, "part1.txt")) && existsSync(join(root, "part2.txt"))).toBe(true);
    expect(o.capsule).toMatchObject({ nativeSessionId: "sid-A", holderProfileId: "b" });
    expect(o.resumable).toBeUndefined();
  });

  it("next account also limited → the third account resumes natively; per-try model attestation", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b", "c"],
      script: function* ({ profile, spec, emit, resume }) {
        if (profile === "a") {
          seedSession(spec.cwd, "a", "sid-A");
          yield emit({
            type: "started",
            observed_model: "m1",
            payload: { native_session_id: "sid-A" },
          });
          writeFileSync(join(spec.cwd, "part1.txt"), "x\n");
          yield emit({ type: "file_change", payload: { path: "part1.txt" } });
          yield* limit(emit);
          return;
        }
        expect(resume).toBe("sid-A");
        if (profile === "b") {
          // b attests a DIFFERENT model, then hits its own limit.
          yield emit({
            type: "started",
            observed_model: "m2",
            payload: { native_session_id: "sid-A" },
          });
          yield emit({ type: "thinking", text: "resuming" });
          yield* limit(emit, null);
          return;
        }
        // c: no model evidence at all.
        yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    expect(o.spawns.map((s) => [s.profile, s.resume])).toEqual([
      ["a", null],
      ["b", "sid-A"],
      ["c", "sid-A"],
    ]);
    expect(o.receipts.map((r) => [r["carrier"], r["observedModel"], r["modelMismatch"]])).toEqual([
      ["native_moved", "m2", true],
      ["native_moved", null, null],
    ]);
    expect(o.capsule?.holderProfileId).toBe("c");
  });

  it("transport death after an edit → the SAME account resumes natively (bounded by max_retries)", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 2,
      script: function* ({ spec, emit, resume, tryOfProfile }) {
        if (tryOfProfile === 1) {
          seedSession(spec.cwd, "a", "sid-A");
          yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
          writeFileSync(join(spec.cwd, "part1.txt"), "x\n");
          yield emit({ type: "file_change", payload: { path: "part1.txt" } });
          yield* crash(emit);
          return;
        }
        expect(resume).toBe("sid-A");
        yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
        yield emit({ type: "usage", usage: { input_tokens: 4321 } });
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    expect(o.spawns.map((s) => [s.profile, s.resume])).toEqual([
      ["a", null],
      ["a", "sid-A"],
    ]);
    expect(o.rotated).toHaveLength(0);
    expect(o.receipts[0]).toMatchObject({
      carrier: "native",
      cause: "transport",
      from: { profileId: "a" },
      to: { profileId: "a" },
      reingestedTokens: 4321,
    });
  });

  it.each([
    { continuity: "file", resumedAs: "sid-A", identity: "matched_before_effects" },
    { continuity: "none", resumedAs: "sid-B", identity: "not_applicable" },
  ] as const)(
    "a same-account resume reports only the identity it compared ($continuity continuity, resumed as $resumedAs)",
    async ({ continuity, resumedAs, identity }) => {
      const o = await run({
        mode: "agent",
        profiles: ["a"],
        maxRetries: 2,
        ...(continuity === "none" ? { continuity: null } : {}),
        script: function* ({ spec, emit, resume, tryOfProfile }) {
          if (tryOfProfile === 1) {
            seedSession(spec.cwd, "a", "sid-A");
            yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
            writeFileSync(join(spec.cwd, "part1.txt"), "x\n");
            yield emit({ type: "file_change", payload: { path: "part1.txt" } });
            yield* crash(emit);
            return;
          }
          expect(resume).toBe("sid-A");
          yield emit({ type: "started", payload: { native_session_id: resumedAs } });
          yield emit({ type: "message", text: "finished", final: true });
          yield emit({ type: "completed" });
        },
      });
      expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
      expect(o.receipts).toHaveLength(1);
      expect(o.receipts[0]).toMatchObject({ carrier: "native", identityCheck: identity });
    },
  );

  it("transport death after an edit with NO session reported → same-account PACKET (1B), bounded by max_retries", async () => {
    const continued = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 2,
      continuity: null,
      script: function* ({ spec, emit, resume, tryOfProfile }) {
        if (tryOfProfile === 1) {
          yield emit({ type: "started" });
          writeFileSync(join(spec.cwd, "part1.txt"), "x\n");
          yield emit({ type: "file_change", payload: { path: "part1.txt" } });
          yield* crash(emit);
          return;
        }
        expect(resume).toBeNull();
        yield emit({ type: "started" });
        yield emit({ type: "message", text: "re-briefed and finished", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(continued.result.lifecycle, continued.result.summary).toBe("succeeded");
    expect(continued.spawns.map((s) => [s.profile, s.resume])).toEqual([
      ["a", null],
      ["a", null],
    ]);
    expect(continued.spawns[1]!.prompt).toContain("# Evidence index of the interrupted work");
    expect(continued.rotated).toHaveLength(0);
    expect(continued.receipts.map((r) => [r["carrier"], r["cause"], r["memory"]])).toEqual([
      ["packet", "transport", "partial"],
    ]);

    // The bound: a process that keeps dying stops after max_retries continuations, continuable.
    const bounded = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 2,
      continuity: null,
      script: function* ({ spec, emit, tryOfProfile }) {
        yield emit({ type: "started" });
        writeFileSync(join(spec.cwd, `part${tryOfProfile}.txt`), "x\n");
        yield emit({ type: "file_change", payload: { path: `part${tryOfProfile}.txt` } });
        yield* crash(emit);
      },
    });
    expect(bounded.result.lifecycle).not.toBe("succeeded");
    expect(bounded.spawns.map((s) => s.profile)).toEqual(["a", "a", "a"]);
    expect(bounded.resumable).toMatchObject({ cause: "transport", carriers: ["packet"] });
  });

  it("a packet continuation with no requested model pins the attested model only when the route lists it", async () => {
    const continueAfter = (observed: string) =>
      run({
        mode: "agent",
        profiles: ["a", "b"],
        maxRetries: 1,
        continuity: null,
        model: null,
        script: function* ({ spec, emit, tryOfProfile }) {
          if (tryOfProfile === 1) {
            yield emit({ type: "started", observed_model: observed });
            writeFileSync(join(spec.cwd, "part1.txt"), "x\n");
            yield emit({ type: "file_change", payload: { path: "part1.txt" } });
            yield* crash(emit);
            return;
          }
          yield emit({ type: "started" });
          yield emit({ type: "message", text: "finished", final: true });
          yield emit({ type: "completed" });
        },
      });
    const label = await continueAfter("Fake Model 1M Extra High");
    expect(label.result.lifecycle, label.result.summary).toBe("succeeded");
    expect(label.spawns.map((s) => s.model)).toEqual([null, null]);
    const listed = await continueAfter("m1");
    expect(listed.result.lifecycle, listed.result.summary).toBe("succeeded");
    expect(listed.spawns.map((s) => s.model)).toEqual([null, "m1"]);
  });

  it("native rejected by the adapter's typed fact → same-account PACKET with the evidence index (1B), never a fresh replay", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 3,
      continuity: fileStoreContinuity({
        rejectsCarriedState: (ev) =>
          ev.type === "error" && ev.payload?.["code"] === "fake_invalid_encrypted_content",
      }),
      script: function* ({ spec, emit, resume, tryOfProfile }) {
        if (tryOfProfile === 1) {
          seedSession(spec.cwd, "a", "sid-A");
          yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
          yield emit({
            type: "tool_call",
            tool: { name: "Bash", kind: "command", target: "make" },
          });
          yield emit({ type: "message", text: "ran make" });
          yield* crash(emit);
          return;
        }
        if (tryOfProfile === 2) {
          expect(resume).toBe("sid-A");
          yield emit({
            type: "error",
            error: "vendor rejected the carried state",
            payload: { code: "fake_invalid_encrypted_content" },
          });
          yield emit({ type: "completed" });
          return;
        }
        expect(resume).toBeNull();
        yield emit({ type: "started", payload: { native_session_id: "sid-C" } });
        yield emit({ type: "message", text: "re-briefed and finished", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    expect(o.spawns.map((s) => [s.profile, s.resume])).toEqual([
      ["a", null],
      ["a", "sid-A"],
      ["a", null],
    ]);
    const packetPrompt = o.spawns[2]!.prompt;
    expect(packetPrompt).toContain("WORK-ORDER-7f3a");
    expect(packetPrompt).toContain("# Evidence index of the interrupted work");
    expect(packetPrompt).toContain("- Bash — make (unresolved: no result recorded)");
    expect(o.receipts.map((r) => [r["carrier"], r["memory"]])).toEqual([
      ["native", "unknown"],
      ["packet", "partial"],
    ]);
    expect(existsSync(join(o.attemptDir!, "continuation", "evidence-index-try2.md"))).toBe(true);
  });

  it("typed limit + move unsupported → hop with a packet (1B); a hop before progress stays a fresh replay", async () => {
    const acted = await run({
      mode: "agent",
      profiles: ["a", "b"],
      continuity: null,
      script: function* ({ profile, spec, emit, resume }) {
        if (profile === "a") {
          yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
          writeFileSync(join(spec.cwd, "part1.txt"), "x\n");
          yield emit({ type: "file_change", payload: { path: "part1.txt" } });
          yield* limit(emit);
          return;
        }
        expect(resume).toBeNull();
        yield emit({ type: "started", payload: { native_session_id: "sid-B" } });
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(acted.result.lifecycle, acted.result.summary).toBe("succeeded");
    expect(acted.spawns[1]!.prompt).toContain("# Evidence index of the interrupted work");
    expect(acted.spawns[1]!.prompt).toContain("- part1.txt");
    expect(acted.receipts[0]).toMatchObject({
      carrier: "packet",
      cause: "vendor_limit",
      to: { profileId: "b" },
    });
    const fresh = await run({
      mode: "agent",
      profiles: ["a", "b"],
      continuity: null,
      script: function* ({ profile, emit }) {
        if (profile === "a") {
          yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
          yield* limit(emit);
          return;
        }
        yield emit({ type: "started", payload: { native_session_id: "sid-B" } });
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(fresh.result.lifecycle).toBe("succeeded");
    expect(fresh.spawns[1]!.prompt).toBe(fresh.spawns[0]!.prompt);
    expect(fresh.receipts).toHaveLength(0);
  });

  it("pool spent after progress → typed terminal with `resumable` (code, resetsAt, carriers)", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      script: function* ({ profile, spec, emit }) {
        if (profile === "a") {
          seedSession(spec.cwd, "a", "sid-A");
          yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
          writeFileSync(join(spec.cwd, "part1.txt"), "x\n");
          yield emit({ type: "file_change", payload: { path: "part1.txt" } });
          yield* limit(emit);
          return;
        }
        yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
        yield emit({ type: "thinking", text: "resuming" });
        yield* limit(emit);
      },
    });
    expect(o.result.lifecycle).toBe("failed");
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.resumable).toMatchObject({
      cause: "pool_exhausted",
      resetsAt: RESET,
      limitWindow: "five_hour",
      limitEvidence: "window",
      limitCode: "credential_pool_exhausted",
      carriers: ["native", "native_moved", "packet"],
      session: { harness: "fake", nativeSessionId: "sid-A", holderProfileId: "b" },
      workspace: { kind: "in_place", root: o.root },
    });
    expect(existsSync(join(o.result.runDir, "final", "resumable.yaml"))).toBe(true);
  });

  it("pinned account + typed limit after progress → typed terminal, no hop, still resumable", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      pinned: "a",
      script: function* ({ spec, emit }) {
        seedSession(spec.cwd, "a", "sid-A");
        yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
        writeFileSync(join(spec.cwd, "part1.txt"), "x\n");
        yield emit({ type: "file_change", payload: { path: "part1.txt" } });
        yield* limit(emit);
      },
    });
    expect(o.result.lifecycle).toBe("failed");
    expect(o.spawns).toHaveLength(1);
    expect(o.resumable).toMatchObject({
      cause: "pinned_limit",
      limitCode: "subscription_window_exhausted",
      resetsAt: RESET,
      carriers: ["native", "native_moved", "packet"],
    });
  });

  it("wrong session identity on `started` stops the try before effects and re-briefs with a packet", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 3,
      script: function* ({ spec, emit, resume, tryOfProfile }) {
        if (tryOfProfile === 1) {
          seedSession(spec.cwd, "a", "sid-A");
          yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
          yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
          yield* crash(emit);
          return;
        }
        if (tryOfProfile === 2) {
          expect(resume).toBe("sid-A");
          // The vendor silently started a NEW conversation.
          yield emit({ type: "started", payload: { native_session_id: "sid-OTHER" } });
          yield emit({ type: "message", text: "hello from the wrong chat" });
          yield emit({ type: "completed", aborted: true });
          return;
        }
        expect(resume).toBeNull();
        yield emit({ type: "started", payload: { native_session_id: "sid-P" } });
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    expect(o.receipts.map((r) => [r["carrier"], r["identityCheck"]])).toEqual([
      ["native", "mismatch_before_effects"],
      ["packet", "not_applicable"],
    ]);
  });

  it("codex-style adapter identity refusal before the turn starts is read as a typed mismatch", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      script: function* ({ spec, emit, resume, tryOfProfile }) {
        if (tryOfProfile === 1) {
          seedSession(spec.cwd, "a", "sid-A");
          yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
          yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
          yield* crash(emit);
          return;
        }
        if (tryOfProfile === 2) {
          expect(resume).toBe("sid-A");
          yield emit({
            type: "error",
            error: "recovered thread differs",
            payload: { code: CONTINUITY_IDENTITY_MISMATCH_CODE },
          });
          yield emit({ type: "completed" });
          return;
        }
        yield emit({ type: "started", payload: { native_session_id: "sid-P" } });
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    expect(o.receipts[0]).toMatchObject({
      carrier: "native",
      identityCheck: "mismatch_before_effects",
    });
    expect(o.receipts[1]).toMatchObject({ carrier: "packet" });
  });
});

describe("in-run continuation (read-only twin)", () => {
  it("tool-only progress without a diff → hop → resumed try rejected → packet, never a fresh replay of the work order", async () => {
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      continuity: fileStoreContinuity({
        rejectsCarriedState: (ev) =>
          ev.type === "error" && ev.payload?.["code"] === "fake_rejected",
      }),
      script: function* ({ profile, emit, resume, tryOfProfile, spec }) {
        if (profile === "a") {
          seedSession(join(spec.cwd), "a", "sid-A");
          yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
          yield emit({ type: "tool_call", tool: { name: "Grep", kind: "search", target: "TODO" } });
          yield* limit(emit);
          return;
        }
        if (tryOfProfile === 1) {
          expect(resume).toBe("sid-A");
          expect(spec.prompt).not.toContain("WORK-ORDER-7f3a");
          yield emit({ type: "error", error: "rejected", payload: { code: "fake_rejected" } });
          yield emit({ type: "completed" });
          return;
        }
        expect(resume).toBeNull();
        yield emit({ type: "started", payload: { native_session_id: "sid-B2" } });
        yield emit({ type: "message", text: "the answer", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    expect(o.spawns.map((s) => [s.profile, s.resume])).toEqual([
      ["a", null],
      ["b", "sid-A"],
      ["b", null],
    ]);
    expect(o.spawns[2]!.prompt).toContain("- Grep — TODO (unresolved: no result recorded)");
    expect(o.receipts.map((r) => r["carrier"])).toEqual(["native_moved", "packet"]);
  });

  it("session capsule survives the attempt (a daemon restart reads the same record)", async () => {
    const o = await run({
      mode: "ask",
      profiles: ["a"],
      script: function* ({ emit }) {
        yield emit({ type: "started", payload: { native_session_id: "sid-R" } });
        yield emit({ type: "message", text: "the answer", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle).toBe("succeeded");
    expect(o.capsule).toMatchObject({
      harness: "fake",
      nativeSessionId: "sid-R",
      holderProfileId: "a",
    });
    expect(
      JSON.parse(readFileSync(join(o.attemptDir!, "session-capsule.json"), "utf8")),
    ).toMatchObject({
      nativeSessionId: "sid-R",
    });
  });
});
