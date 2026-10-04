import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCursorParser } from "../../harness-cursor/src/parse.js";
import { harnessEventPayload } from "../../orchestrator/src/runSupport.js";
import { createRunEventLineFormatter } from "./live.js";

describe("CLI retained-evidence display", () => {
  it("prints the recorded Cursor flush once while keeping the buffered receipt", () => {
    const parse = createCursorParser();
    const events = readFileSync(
      new URL("../../harness-cursor/fixtures/stream/text-deltas.jsonl", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n")
      .flatMap((line) => parse(JSON.parse(line), "fixture") ?? []);
    const format = createRunEventLineFormatter();
    const rows = events.map((event) => ({
      event,
      line: format({ type: "harness.event", payload: harnessEventPayload("cursor", "a01", event) }),
    }));
    const buffered = rows.filter(({ event }) => event.payload?.["buffered"] === true);
    expect(buffered).toHaveLength(1);
    expect(buffered[0]?.line).toBeNull();
    expect(rows.filter(({ line }) => line === "[a01/cursor] Final answer.")).toHaveLength(1);
    expect(rows.find(({ event }) => event.final === true)?.line).toBeNull();
  });
});
