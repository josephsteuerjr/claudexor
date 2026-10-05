import { HarnessEvent } from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import {
  CodexSubagentThreads,
  codexTerminalEvents,
  notificationThreadId,
  ownsNotification,
} from "./app-server-threads.js";

describe("root-thread ownership of app-server notifications", () => {
  it("treats frames without a threadId, or on the root thread, as the root's", () => {
    expect(ownsNotification(null, "thread-root")).toBe(true);
    expect(ownsNotification({ turn: { id: "turn-1" } }, "thread-root")).toBe(true);
    expect(ownsNotification({ threadId: "thread-root" }, "thread-root")).toBe(true);
    expect(ownsNotification({ threadId: "thread-child" }, "thread-root")).toBe(false);
    // Unknown ownership must wait for the start reply, including legacy frames.
    expect(ownsNotification({ threadId: "thread-child" }, null)).toBe(false);
    expect(ownsNotification({ threadId: "thread-root" }, null)).toBe(false);
    expect(ownsNotification(null, null)).toBe(false);
    expect(notificationThreadId({ threadId: 7 })).toBeNull();
    expect(notificationThreadId({ threadId: "thread-child" })).toBe("thread-child");
  });
});

describe("CodexSubagentThreads", () => {
  const params = (extra: Record<string, unknown>) => ({
    threadId: "thread-child",
    turnId: "turn-child",
    ...extra,
  });

  it("re-emits sub-agent text as a tagged status event, never a message", () => {
    const threads = new CodexSubagentThreads();
    const events = threads.events(
      {
        method: "item/completed",
        params: params({ item: { type: "agentMessage", id: "m1", text: "[]\nNO_FINDINGS" } }),
      },
      "ses",
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "status",
        session_id: "ses",
        text: "[]\nNO_FINDINGS",
        payload: {
          code: "subagent_message",
          native_thread_id: "thread-child",
          native_turn_id: "turn-child",
          subagent: true,
        },
      }),
    ]);
    expect(events?.[0]).not.toHaveProperty("final");
    expect(HarnessEvent.safeParse(events?.[0]).success).toBe(true);
    expect(threads.count).toBe(1);
  });

  it("keeps tool, usage and thinking events, tagged with the thread", () => {
    const threads = new CodexSubagentThreads();
    const started = threads.events(
      {
        method: "item/started",
        params: params({
          item: { type: "commandExecution", id: "cmd", command: "cat x", status: "inProgress" },
        }),
      },
      "ses",
    );
    expect(started).toEqual([
      expect.objectContaining({
        type: "tool_call",
        tool: expect.objectContaining({ use_id: "cmd" }),
        payload: expect.objectContaining({
          status: "inProgress",
          native_thread_id: "thread-child",
          subagent: true,
        }),
      }),
    ]);
    const failed = threads.events(
      {
        method: "item/completed",
        params: params({
          item: {
            type: "commandExecution",
            id: "cmd",
            command: "cat x",
            status: "failed",
            exitCode: 1,
            aggregatedOutput: "cat: x: No such file",
          },
        }),
      },
      "ses",
    );
    expect(failed?.[0]).toMatchObject({
      type: "tool_result",
      tool: { status: "error", exit_code: 1 },
      payload: { native_thread_id: "thread-child", subagent: true },
    });
    const usage = threads.events(
      {
        method: "thread/tokenUsage/updated",
        params: params({ tokenUsage: { last: { inputTokens: 11, outputTokens: 5 } } }),
      },
      "ses",
    );
    expect(usage?.[0]).toMatchObject({
      type: "usage",
      usage: { input_tokens: 11, output_tokens: 5 },
      payload: { native_thread_id: "thread-child", subagent: true },
    });
    expect(threads.count).toBe(1);
  });

  it("strips a sub-agent's plan progress so it cannot overwrite the root's plan", () => {
    const threads = new CodexSubagentThreads();
    const events = threads.events(
      {
        method: "turn/plan/updated",
        params: params({ plan: [{ step: "child step", status: "inProgress" }] }),
      },
      "ses",
    );
    expect(events).toHaveLength(1);
    expect(events?.[0]?.type).toBe("status");
    expect(events?.[0]).not.toHaveProperty("plan_progress");
    expect(events?.[0]?.text).toContain("child step");
  });

  it("recognizes sub-agent lifecycle frames without finality and reports unknown ones as null", () => {
    const threads = new CodexSubagentThreads();
    for (const method of [
      "turn/started",
      "turn/completed",
      "thread/started",
      "thread/status/changed",
      "mcpServer/startupStatus/updated",
    ]) {
      expect(
        threads.events({ method, params: params({ turn: { id: "turn-child" } }) }, "ses"),
      ).toEqual([]);
    }
    expect(
      threads.events({ method: "item/agentMessage/delta", params: params({}) }, "ses"),
    ).toBeNull();
    expect(
      threads.events({ method: "thread/status/changed", params: { threadId: "other" } }, "ses"),
    ).toEqual([]);
    expect(threads.count).toBe(2);
  });
});

describe("codexTerminalEvents", () => {
  it("finalizes the root's last agent message on a completed turn", () => {
    const terminal = codexTerminalEvents({
      pendingTerminal: { id: "turn-root", status: "completed" },
      systemError: false,
      sessionId: "ses",
      parseState: { lastAgentMessage: "root answer" },
    });
    expect(terminal.reportedError).toBeNull();
    expect(terminal.events).toEqual([
      expect.objectContaining({ type: "message", text: "root answer", final: true }),
    ]);
  });

  it("types a failed turn and a durable systemError as reported errors", () => {
    const failed = codexTerminalEvents({
      pendingTerminal: { id: "turn-root", status: "failed", error: { message: "boom" } },
      systemError: false,
      sessionId: "ses",
      parseState: {},
    });
    expect(failed.reportedError).toBe(true);
    expect(failed.events).toEqual([expect.objectContaining({ type: "error", error: "boom" })]);
    const systemError = codexTerminalEvents({
      pendingTerminal: null,
      systemError: true,
      sessionId: "ses",
      parseState: {},
    });
    expect(systemError.reportedError).toBe(true);
    expect(systemError.events[0]).toMatchObject({
      type: "error",
      payload: { code: "codex_app_server_failure" },
    });
    expect(
      codexTerminalEvents({
        pendingTerminal: { id: "t", status: "interrupted" },
        systemError: false,
        sessionId: "ses",
        parseState: {},
      }),
    ).toEqual({ events: [], reportedError: null });
  });
});
