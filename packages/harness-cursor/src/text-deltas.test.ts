import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  AnswerAssembly,
  streamExpectationViolations,
  type FixtureStreamExpectations,
} from "@claudexor/core";
import { HarnessEvent } from "@claudexor/schema";
import { createCursorParser, parseCursorEvent } from "./parse.js";

function replayFixture(path: string): HarnessEvent[] {
  const parse = createCursorParser();
  return readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => parse(JSON.parse(line), "ses-text-deltas") ?? []);
}

describe("Cursor text fragment semantics", () => {
  it("preserves word and whitespace fragments without changing the complete final answer", () => {
    const fixture = "stream/text-deltas.jsonl";
    const events = replayFixture(fixture);
    const manifest = parseYaml(
      readFileSync(new URL("../fixtures/manifest.yaml", import.meta.url), "utf8"),
    ) as { fixtures: Record<string, { expectations: FixtureStreamExpectations }> };
    for (const event of events) expect(() => HarnessEvent.parse(event)).not.toThrow();
    expect(streamExpectationViolations(events, manifest.fixtures[fixture]!.expectations)).toEqual(
      [],
    );

    const thinking = events.filter((event) => event.type === "thinking");
    expect(thinking.map((event) => event.text)).toEqual([
      "UX and inter",
      "action",
      " ",
      "plan · with authored punctuation.\n",
    ]);
    expect(thinking.every((event) => event.payload?.["delta"] === true)).toBe(true);
    expect(thinking.map((event) => event.text).join("")).toBe(
      "UX and interaction plan · with authored punctuation.\n",
    );

    const completeMessages = events.filter(
      (event) =>
        event.type === "message" &&
        event.payload?.["delta"] !== true &&
        event.payload?.["buffered"] !== true,
    );
    expect(completeMessages.map((event) => event.text)).toEqual(["Final answer.", "Final answer."]);
    expect(completeMessages.at(-1)?.final).toBe(true);
    const answer = new AnswerAssembly();
    for (const event of events) answer.observe(event);
    expect(answer.text()).toBe("Final answer.");
  });

  it.each([
    "plan/plan-ask-workreport-recorded.jsonl",
    "plan/plan-ask-permission-denied-recorded.jsonl",
  ])("retains the recorded native delta declaration in %s", (fixture) => {
    const thinking = replayFixture(fixture).filter((event) => event.type === "thinking");
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking.every((event) => event.payload?.["delta"] === true)).toBe(true);
  });

  it.each(["thinking", "reasoning"])("requires explicit delta subtype for %s", (type) => {
    const fragment = parseCursorEvent({ type, subtype: "delta", message: " " }, "s1");
    expect(fragment?.[0]).toMatchObject({
      type: "thinking",
      text: " ",
      payload: { delta: true },
    });
    for (const subtype of [undefined, "completed"]) {
      const complete = parseCursorEvent({ type, subtype, text: "A complete block." }, "s1");
      expect(complete?.[0]?.text).toBe("A complete block.");
      expect(complete?.[0]?.payload?.["delta"]).toBeUndefined();
    }
    expect(parseCursorEvent({ type, subtype: "completed" }, "s1")).toEqual([]);
  });
});
