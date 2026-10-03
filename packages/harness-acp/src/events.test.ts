import { describe, expect, it } from "vitest";
import { validateTypedStream } from "@claudexor/core";
import { copilot } from "./entry.js";
import { AcpEvents } from "./events.js";

const message = (text: string, child = false) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
  ...(child ? { _meta: { parentToolCallId: "parent" } } : {}),
});

describe("ACP event translation", () => {
  it("distinguishes configuration notices, narration, child messages and the final answer", () => {
    const events = new AcpEvents("s", copilot.disabledToolsNotice);
    expect(events.update(message("Info: Disabled tools: bash\n"))[0]?.type).toBe("status");
    // The notice is vendor-row data: an entry without one keeps the chunk as answer text.
    expect(new AcpEvents("s").update(message("Info: Disabled tools: bash\n"))[0]?.type).toBe(
      "message",
    );
    events.update(message("Checking..."));
    const call = {
      sessionUpdate: "tool_call",
      toolCallId: "t",
      title: "Read",
      kind: "read",
      status: "in_progress",
    };
    events.update(call);
    events.update(message("child answer", true));
    events.update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" });
    events.update(message("Done. "));
    events.update(message("Next."));
    expect(events.finish("end_turn")[0]).toMatchObject({
      final: true,
      text: "Done. Next.",
      payload: { final_source: "session/prompt" },
    });
    expect(events.update(message("Info: Disabled tools: ordinary later text"))[0]?.type).toBe(
      "message",
    );
  });

  it("maps thoughts, plans, tool errors, diff and cumulative cost into valid events", () => {
    const parser = new AcpEvents("s");
    const updates = [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } },
      {
        sessionUpdate: "plan",
        entries: [{ content: "Check", priority: "high", status: "in_progress" }],
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        kind: "execute",
        title: "test",
        status: "in_progress",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        status: "completed",
        rawOutput: { exitCode: 7 },
        content: [{ type: "diff", path: "/work/a", oldText: null, newText: "a" }],
      },
      {
        sessionUpdate: "usage_update",
        used: 1000,
        size: 8000,
        cost: { amount: 0.25, currency: "USD" },
      },
      {
        sessionUpdate: "usage_update",
        used: 2000,
        size: 8000,
        cost: { amount: 0.5, currency: "USD" },
      },
      { sessionUpdate: "usage_update", used: 2500, size: 8000 },
    ];
    const events = updates.flatMap((update) => parser.update(update));
    expect(validateTypedStream(events)).toMatchObject({
      toolCalls: 1,
      toolResults: 1,
      errorToolResults: 1,
      fileChanges: 1,
      usageEvents: 3,
    });
    expect(events.filter((e) => e.usage).map((e) => e.usage)).toEqual([
      { cost_usd: 0.25 },
      { cost_usd: 0.25 },
      {},
    ]);
    expect(parser.update(updates[3])).toEqual([]);
  });

  it.each(["refusal", "max_tokens", "max_turn_requests", "future_stop"])(
    "refuses terminal %s",
    (reason) => {
      expect(() => new AcpEvents("s").finish(reason)).toThrow(`ACP turn stopped: ${reason}`);
    },
  );

  it("requires a closed tool lifecycle and a nonempty root answer", () => {
    const events = new AcpEvents("s");
    expect(() => events.finish("end_turn")).toThrow("no final answer");
    events.update({ sessionUpdate: "tool_call", toolCallId: "open", title: "Pending" });
    events.update(message("Looks done"));
    expect(() => events.finish("end_turn")).toThrow("unfinished tool calls");
    expect(events.finish("cancelled")).toEqual([]);
    expect(events.update({ sessionUpdate: "future_update", payload: { anything: true } })).toEqual(
      [],
    );
  });

  // ACP v1 tool_call_update frames carry only changed fields; an absent field
  // keeps its previous value, so the result reads the accumulated call.
  const split = (output: Record<string, unknown>) => {
    const events = new AcpEvents("s");
    events.update({
      sessionUpdate: "tool_call",
      toolCallId: "t",
      title: "Run tests",
      kind: "execute",
      status: "in_progress",
    });
    expect(
      events.update({ sessionUpdate: "tool_call_update", toolCallId: "t", rawOutput: output }),
    ).toEqual([]);
    return events.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
    });
  };
  it.each([
    [{ exitCode: 7 }, "error", 7],
    [{ isError: true }, "error", undefined],
    [{ success: false }, "error", undefined],
    [{ exitCode: 0 }, "ok", 0],
    [{ output: "done" }, "ok", undefined],
  ])("keeps rawOutput %j across a split terminal update", (output, status, exitCode) => {
    expect(split(output)).toEqual([
      expect.objectContaining({
        type: "tool_result",
        tool: {
          name: "Run tests",
          kind: "command",
          use_id: "t",
          status,
          ...(exitCode === undefined ? {} : { exit_code: exitCode }),
        },
      }),
    ]);
  });

  // The ACP SDK treats a null field like an omitted one: it keeps the earlier value.
  it("keeps the earlier facts when a later frame sends null fields", () => {
    const events = new AcpEvents("s");
    events.update({
      sessionUpdate: "tool_call",
      toolCallId: "t",
      title: "Run tests",
      kind: "execute",
      status: "in_progress",
    });
    events.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      rawOutput: { exitCode: 7 },
    });
    expect(
      events.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        status: "completed",
        rawOutput: null,
        title: null,
      })[0]?.tool,
    ).toEqual({ name: "Run tests", kind: "command", use_id: "t", status: "error", exit_code: 7 });
  });

  it("names the result from fields that arrived after the tool call", () => {
    const events = new AcpEvents("s");
    events.update({ sessionUpdate: "tool_call", toolCallId: "t", title: "", status: "pending" });
    events.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      kind: "read",
      title: "a.ts",
    });
    expect(
      events.update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "failed" })[0]
        ?.tool,
    ).toEqual({ name: "a.ts", kind: "file", use_id: "t", status: "error" });
  });

  it("does not infer a failure from command output prose", () => {
    const events = new AcpEvents("s");
    const result = events.update({
      sessionUpdate: "tool_call",
      toolCallId: "t",
      status: "completed",
      rawOutput: { output: "exit code 1: this is quoted documentation" },
    });
    expect(result.at(-1)?.tool?.status).toBe("ok");
  });

  it("retains a diff that arrives before the tool finishes", () => {
    const events = new AcpEvents("s");
    expect(
      events
        .update({
          sessionUpdate: "tool_call",
          toolCallId: "t",
          kind: "edit",
          status: "in_progress",
          content: [{ type: "diff", path: "a", oldText: "old", newText: "new" }],
        })
        .map((e) => e.type),
    ).toEqual(["tool_call", "file_change"]);
    expect(
      events
        .update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" })
        .map((e) => e.type),
    ).toEqual(["tool_result"]);
  });
});
