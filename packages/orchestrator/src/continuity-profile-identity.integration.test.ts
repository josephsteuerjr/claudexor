/** Mixed-harness profile registries through the real continuation controller, offline. */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessEvent } from "@claudexor/schema";
import { claudeContinuity } from "../../harness-claude/src/continuity.js";
import { crash, fileStoreContinuity, limit, run } from "./inrun-continuity.test-support.js";

const SID = "00000000-0000-4000-8000-000000000001";
const HISTORY = '{"message":"saved native history"}\n';
const FOREIGN = '{"message":"another harness owns these bytes"}\n';
const sessionFile = (store: string) => join(store, "sessions", `${SID}.jsonl`);
function seed(store: string, content = HISTORY): string {
  const file = sessionFile(store);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

describe.each(["agent", "ask"] as const)("profile identity in %s", (mode) => {
  it.each(
    (["source", "target", "both"] as const).flatMap((collision) =>
      [true, false].map((foreignFirst) => ({ collision, foreignFirst })),
    ),
  )(
    "moves the actual session with $collision collision, foreign first: $foreignFirst",
    async ({ collision, foreignFirst }) => {
      const foreignFiles: string[] = [];
      const o = await run({
        mode,
        profiles: ["a", "b"],
        registryProfiles: (profiles) => {
          const foreign = profiles
            .filter(
              (row) =>
                collision === "both" || row.profile_id === (collision === "source" ? "a" : "b"),
            )
            .map((row) => {
              const store = join(dirname(row.isolation_locator!), `foreign-${row.profile_id}`);
              foreignFiles.push(seed(store, FOREIGN));
              return {
                ...row,
                harness_id: row.profile_id === "a" ? "claude" : "codex",
                isolation_locator: store,
              };
            });
          return foreignFirst ? [...foreign, ...profiles] : [...profiles, ...foreign];
        },
        script: function* ({ profile, spec, emit, resume }) {
          const store = spec.credential_profile!.isolation_locator!;
          if (profile === "a") {
            seed(store);
            yield emit({
              type: "started",
              observed_model: "m1",
              payload: { native_session_id: SID },
            });
            yield emit({
              type: "tool_call",
              tool: { name: "Read", kind: "file", target: "README.md" },
            });
            if (mode === "agent") {
              writeFileSync(join(spec.cwd, "part1.txt"), "kept work\n");
              yield emit({ type: "file_change", payload: { path: "part1.txt" } });
            }
            yield* limit(emit);
            return;
          }
          // The resumed process opens its own resolved profile store, not the planner's locator.
          expect(resume).toBe(SID);
          expect(readFileSync(sessionFile(store), "utf8")).toBe(HISTORY);
          yield emit({
            type: "started",
            observed_model: "m1",
            payload: { native_session_id: SID },
          });
          yield emit({ type: "message", text: "Finished the saved work.", final: true });
          yield emit({ type: "completed" });
        },
      });
      expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
      expect(o.spawns.map((spawn) => [spawn.profile, spawn.resume])).toEqual([
        ["a", null],
        ["b", SID],
      ]);
      expect(o.receipts).toHaveLength(1);
      expect(o.receipts[0]).toMatchObject({
        carrier: "native_moved",
        from: { profileId: "a" },
        to: { profileId: "b" },
        memory: "full",
      });
      expect(o.capsule).toMatchObject({
        harness: "fake",
        holderProfileId: "b",
        file: sessionFile(o.stores.b!),
      });
      expect(existsSync(sessionFile(o.stores.a!))).toBe(false);
      expect(readFileSync(sessionFile(o.stores.b!), "utf8")).toBe(HISTORY);
      for (const file of foreignFiles) expect(readFileSync(file, "utf8")).toBe(FOREIGN);
      if (mode === "agent")
        expect(readFileSync(join(o.root, "part1.txt"), "utf8")).toBe("kept work\n");
    },
  );

  it.each([true, false])(
    "relocates a same-account capsule in its harness, foreign first: %s",
    async (foreignFirst) => {
      let foreignFile = "";
      const o = await run({
        mode,
        profiles: ["a"],
        registryProfiles: ([row]) => {
          const foreign = {
            ...row!,
            harness_id: "claude",
            isolation_locator: join(dirname(row!.isolation_locator!), "foreign-a"),
          };
          foreignFile = seed(foreign.isolation_locator, FOREIGN);
          return foreignFirst ? [foreign, row!] : [row!, foreign];
        },
        script: function* ({ spec, emit, resume, tryOfProfile }) {
          const store = spec.credential_profile!.isolation_locator!;
          if (tryOfProfile === 1) {
            seed(store);
            yield emit({ type: "started", payload: { native_session_id: SID } });
            yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
            yield* crash(emit);
            return;
          }
          expect(resume).toBe(SID);
          expect(readFileSync(sessionFile(store), "utf8")).toBe(HISTORY);
          yield emit({ type: "started", payload: { native_session_id: SID } });
          yield emit({ type: "message", text: "Finished.", final: true });
          yield emit({ type: "completed" });
        },
      });
      expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
      expect(o.receipts[0]).toMatchObject({ carrier: "native", cause: "transport" });
      expect(o.capsule).toMatchObject({
        harness: "fake",
        holderProfileId: "a",
        file: sessionFile(o.stores.a!),
      });
      expect(readFileSync(foreignFile, "utf8")).toBe(FOREIGN);
    },
  );

  it.each(["missing-session", "transport"] as const)(
    "Claude %s after a native try selects the right next carrier",
    async (failure) => {
      const o = await run({
        mode,
        profiles: ["a"],
        maxRetries: 2,
        continuity: fileStoreContinuity({
          rejectsCarriedState: claudeContinuity.rejectsCarriedState,
        }),
        script: function* ({ spec, emit, resume, tryOfProfile }) {
          const store = spec.credential_profile!.isolation_locator!;
          if (tryOfProfile === 1) {
            seed(store);
            yield emit({ type: "started", payload: { native_session_id: SID } });
            yield emit({
              type: "tool_call",
              tool: { name: "Read", kind: "file", target: "README.md" },
            });
            yield* crash(emit);
            return;
          }
          if (tryOfProfile === 2) {
            expect(resume).toBe(SID);
            if (failure === "missing-session") {
              const fixture = new URL(
                "../../harness-claude/fixtures/signals/missing-resume-session.jsonl",
                import.meta.url,
              );
              for (const line of readFileSync(fixture, "utf8").trim().split("\n")) {
                const event = JSON.parse(line) as HarnessEvent;
                yield emit({ type: event.type, error: event.error, payload: event.payload });
              }
            } else yield* crash(emit);
            return;
          }
          expect(resume).toBe(failure === "missing-session" ? null : SID);
          if (resume) expect(readFileSync(sessionFile(store), "utf8")).toBe(HISTORY);
          yield emit({
            type: "started",
            payload: { native_session_id: resume ?? "fresh-session" },
          });
          yield emit({ type: "message", text: "Finished from retained evidence.", final: true });
          yield emit({ type: "completed" });
        },
      });
      expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
      expect(o.spawns.map((spawn) => spawn.resume)).toEqual([
        null,
        SID,
        failure === "missing-session" ? null : SID,
      ]);
      expect(o.receipts.map((receipt) => receipt.carrier)).toEqual([
        "native",
        failure === "missing-session" ? "packet" : "native",
      ]);
      if (failure === "missing-session") {
        expect(o.spawns[2]!.prompt).toContain("WORK-ORDER-7f3a");
        expect(o.spawns[2]!.prompt).toContain("Read — README.md (unresolved");
        expect(
          readFileSync(join(o.attemptDir!, "continuation", "evidence-index-try2.md"), "utf8"),
        ).toContain("README.md");
      } else expect(o.spawns[2]!.prompt).not.toContain("# Evidence index");
    },
  );
});
