import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_SECTION_BUDGET_BYTES,
  EVIDENCE_TOTAL_BUDGET_BYTES,
  EVIDENCE_TOOL_ROWS,
  buildEvidenceIndex,
  type EvidenceIndexInput,
} from "./continuation-evidence.js";
import {
  collectEvidenceIndexInput,
  diffStatFromPatch,
  steeringFromRunLog,
  toolCallIndex,
} from "./continuation-evidence-io.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

function input(over: Partial<EvidenceIndexInput> = {}): EvidenceIndexInput {
  return {
    cause: "vendor_limit",
    workOrder: "Implement the dashboard mockups.",
    steering: [],
    retainedOutput: "",
    toolCalls: [],
    diffStat: null,
    artifacts: { eventsLog: null, attemptDir: null, patch: null },
    ...over,
  };
}

describe("evidence index (pure)", () => {
  it("is a mechanical index: work order, steering with delivery, output, tools, files, paths", () => {
    const index = buildEvidenceIndex(
      input({
        steering: [
          { text: "Use the blue palette.", delivery: "confirmed" },
          { text: "Also add dark mode.", delivery: "uncertain" },
        ],
        retainedOutput: "Saved two mockups so far.",
        toolCalls: [
          { name: "Write", target: "web/a.html", resolved: true },
          { name: "Bash", target: "npm test", resolved: false },
        ],
        diffStat: "- web/a.html\n- web/b.html",
        artifacts: { eventsLog: "/r/events.jsonl", attemptDir: "/r/attempts/a01", patch: null },
      }),
    );
    expect(index.summarized).toBe(false);
    expect(index.toolCalls).toBe(2);
    expect(index.unresolvedToolCalls).toBe(1);
    const md = index.markdown;
    expect(md).toContain("## Original work order\n\nImplement the dashboard mockups.");
    expect(md).toContain("### Message 1 (delivered)\n\nUse the blue palette.");
    expect(md).toContain(
      "### Message 2 (delivery uncertain — reconcile against the work, do not replay blindly)",
    );
    expect(md).toContain("Saved two mockups so far.");
    expect(md).toContain("- Write — web/a.html (completed)");
    expect(md).toContain("- Bash — npm test (unresolved: no result recorded)");
    expect(md).toContain("- web/a.html\n- web/b.html");
    expect(md).toContain("- Event log: /r/events.jsonl");
    expect(md).toContain("- Attempt artifacts: /r/attempts/a01");
    expect(md).not.toContain("Patch so far");
    expect(md).toContain("(a usage limit on its account)");
  });

  it("truncates honestly: a single cut section flips summarized, the tool index collapses to counts", () => {
    const long = "x".repeat(EVIDENCE_SECTION_BUDGET_BYTES + 100);
    const cut = buildEvidenceIndex(input({ retainedOutput: long }));
    expect(cut.summarized).toBe(true);
    expect(cut.markdown).toContain("…[truncated]");
    const many = buildEvidenceIndex(
      input({
        toolCalls: Array.from({ length: EVIDENCE_TOOL_ROWS + 5 }, (_, i) => ({
          name: `t${i}`,
          target: null,
          resolved: i % 2 === 0,
        })),
      }),
    );
    expect(many.summarized).toBe(true);
    expect(many.markdown).toContain(`${EVIDENCE_TOOL_ROWS + 5} tool calls recorded`);
    expect(many.markdown).not.toContain("- t0 ");
    expect(many.markdown).toContain(`- t${EVIDENCE_TOOL_ROWS + 4} `);
  });
});

describe("evidence collector (I/O)", () => {
  it("pairs legacy rows without ids and reads steering delivery from the run log", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-evidence-"));
    roots.push(dir);
    const row = (type: string, payload: Record<string, unknown>) =>
      JSON.stringify({ ts: "t", run_id: "r", task_id: "k", type, payload });
    writeFileSync(
      join(dir, "events.jsonl"),
      [
        row("harness.event", {
          attempt_id: "a01",
          type: "tool_call",
          tool: { name: "Read", target: "a.txt" },
        }),
        row("harness.event", { attempt_id: "a01", type: "tool_result", tool: { status: "ok" } }),
        row("harness.event", {
          attempt_id: "a01",
          type: "tool_call",
          tool: { name: "Bash", target: "sleep 100" },
        }),
        row("harness.event", { attempt_id: "zz", type: "tool_call", tool: { name: "Other" } }),
        row("message.accepted", { message_id: "m1", text: "first" }),
        row("message.delivered", { message_id: "m1", text: "first" }),
        row("message.accepted", { message_id: "m2", text: "second" }),
        row("message.accepted", { message_id: "m3", text: "third" }),
        row("message.refused", { message_id: "m3", text: "third" }),
        "{not json",
      ].join("\n"),
    );
    mkdirSync(join(dir, "attempts", "a01"), { recursive: true });
    writeFileSync(join(dir, "attempts", "a01", "patch.diff"), "diff");
    const collected = collectEvidenceIndexInput(
      { runDir: dir, attemptId: "a01", workOrder: "W", steering: [] },
      { cause: "transport", retainedOutput: "out", diffStat: null },
    );
    expect(collected.toolCalls).toEqual([
      { name: "Read", target: "a.txt", resolved: true },
      { name: "Bash", target: "sleep 100", resolved: false },
    ]);
    expect(collected.steering).toEqual([
      { text: "first", delivery: "confirmed" },
      { text: "second", delivery: "uncertain" },
    ]);
    expect(collected.artifacts).toEqual({
      eventsLog: join(dir, "events.jsonl"),
      attemptDir: join(dir, "attempts", "a01"),
      patch: join(dir, "attempts", "a01", "patch.diff"),
    });
    expect(steeringFromRunLog(join(dir, "nope"))).toEqual([]);
    expect(toolCallIndex([{ type: "tool_call", text: "Grep for x\nmore" }])).toEqual([
      { name: "Grep for x", target: null, resolved: false },
    ]);
  });

  it("a file edit reported twice (codex started, then completed) is one resolved call", () => {
    const edit = (session: string) => ({
      type: "file_change",
      session_id: session,
      tool: { name: "apply_patch", kind: "file", use_id: "item-7", target: "src/a.ts" },
    });
    expect(toolCallIndex([edit("s1"), edit("s1")])).toEqual([
      { name: "apply_patch", target: "src/a.ts", resolved: true },
    ]);
    // A started edit that never completed stays unresolved; another session's id is its own call.
    expect(toolCallIndex([edit("s1"), edit("s2")])).toEqual([
      { name: "apply_patch", target: "src/a.ts", resolved: false },
      { name: "apply_patch", target: "src/a.ts", resolved: false },
    ]);
  });

  it("prefers the attempt's own event log when present and lists changed files from a patch", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-evidence-"));
    roots.push(dir);
    mkdirSync(join(dir, "attempts", "a01"), { recursive: true });
    writeFileSync(
      join(dir, "attempts", "a01", "events.jsonl"),
      JSON.stringify({ type: "tool_call", tool: { name: "Edit" } }) + "\n",
    );
    writeFileSync(join(dir, "events.jsonl"), "");
    const collected = collectEvidenceIndexInput(
      {
        runDir: dir,
        attemptId: "a01",
        workOrder: "W",
        steering: [{ text: "s", delivery: "confirmed" }],
      },
      { cause: "transport", retainedOutput: "", diffStat: null },
    );
    expect(collected.toolCalls).toEqual([{ name: "Edit", target: null, resolved: false }]);
    expect(collected.steering).toEqual([{ text: "s", delivery: "confirmed" }]);
    expect(
      diffStatFromPatch("diff --git a/src/a.ts b/src/a.ts\n+x\ndiff --git a/b.md b/b.md\n"),
    ).toBe("- src/a.ts\n- b.md");
    expect(diffStatFromPatch("")).toBeNull();
  });
});

describe("evidence review regressions", () => {
  it("pairs results by use id within a try and retains unresolved edit calls", () => {
    const calls = toolCallIndex([
      { session_id: "try-1", type: "file_change", tool: { name: "Write", use_id: "first" } },
      { session_id: "try-1", type: "tool_call", tool: { name: "Read", use_id: "second" } },
      { session_id: "try-1", type: "tool_result", tool: { use_id: "second" } },
      { session_id: "try-2", type: "tool_result", tool: { use_id: "first" } },
      { session_id: "try-1", type: "file_change", tool: { name: "Edit", use_id: "edit" } },
    ]);
    expect(calls).toEqual([
      { name: "Write", target: null, resolved: false },
      { name: "Read", target: null, resolved: true },
      { name: "Edit", target: null, resolved: false },
    ]);
  });

  it("leaves unmatched and ambiguous ids unresolved, with oldest-open fallback only for idless results", () => {
    const rows = [
      { type: "tool_call", tool: { name: "Write", use_id: "duplicate" } },
      { type: "tool_call", tool: { name: "Read", use_id: "duplicate" } },
      { type: "tool_result", tool: { use_id: "missing" } },
      { type: "tool_result", tool: { use_id: "duplicate" } },
    ];
    expect(toolCallIndex(rows).map((c) => c.resolved)).toEqual([false, false]);
    expect(
      toolCallIndex([...rows, { type: "tool_result", tool: {} }]).map((c) => c.resolved),
    ).toEqual([true, false]);
  });

  it("preserves absolute paths and tool counts when the whole index is truncated", () => {
    const index = buildEvidenceIndex(
      input({
        workOrder: "w".repeat(8100),
        steering: [
          { text: "s".repeat(8100), delivery: "confirmed" },
          { text: "t".repeat(8100), delivery: "uncertain" },
        ],
        retainedOutput: "r".repeat(8100),
        toolCalls: [{ name: "Write", target: "pending.txt", resolved: false }],
        artifacts: {
          eventsLog: "/fixture/events.jsonl",
          attemptDir: "/fixture/attempts/a01",
          patch: "/fixture/attempts/a01/patch.diff",
        },
      }),
    );
    expect(index.summarized).toBe(true);
    expect(index.markdown).toContain("/fixture/events.jsonl");
    expect(index.markdown).toContain("/fixture/attempts/a01/patch.diff");
    expect(index.markdown).toContain("Tool calls: 1; unresolved: 1.");
    expect(index.bytes).toBeLessThanOrEqual(EVIDENCE_TOTAL_BUDGET_BYTES);
  });

  it("filters steering by attempt when the log carries an attempt id", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-evidence-"));
    roots.push(dir);
    writeFileSync(
      join(dir, "events.jsonl"),
      [
        {
          type: "message.accepted",
          payload: { attempt_id: "a01", message_id: "one", text: "mine" },
        },
        {
          type: "message.accepted",
          payload: { attempt_id: "a02", message_id: "two", text: "other attempt" },
        },
        {
          type: "message.delivered",
          payload: { attempt_id: "a02", message_id: "two", text: "other attempt" },
        },
        { type: "message.accepted", payload: { message_id: "global", text: "run steering" } },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const collected = collectEvidenceIndexInput(
      { runDir: dir, attemptId: "a01", workOrder: "W", steering: [] },
      { cause: "transport", retainedOutput: "", diffStat: null },
    );
    expect(collected.steering).toEqual([
      { text: "mine", delivery: "uncertain" },
      { text: "run steering", delivery: "uncertain" },
    ]);
  });
});
