// Translation semantics from Róger Valderrama's ouroboros#769; Q00 MIT: ../NOTICE.
import type { SessionUpdate, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { HarnessEvent, ToolRef } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";

export class AcpFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export class AcpEvents {
  private answer = "";
  private answerBytes = 0;
  private firstChunk = true;
  private cost = 0;
  private calls = new Map<string, { tool: ToolRef; terminal: boolean; child: boolean }>();

  constructor(private readonly sessionId: string) {}

  event(type: HarnessEvent["type"], fields: Partial<HarnessEvent> = {}): HarnessEvent {
    return { type, session_id: this.sessionId, ts: nowIso(), ...fields };
  }

  update(value: unknown): HarnessEvent[] {
    const raw = record(value);
    const update = raw as unknown as SessionUpdate;
    const child = typeof record(raw["_meta"])["parentToolCallId"] === "string";
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.content?.type !== "text" || typeof update.content.text !== "string") return [];
        const text = update.content.text;
        if (update.sessionUpdate === "agent_thought_chunk")
          return [this.event("thinking", { text })];
        if (child) return [this.event("status", { payload: { child_message: text } })];
        const notice =
          this.firstChunk &&
          text.startsWith("Info: Disabled tools: ") &&
          !text.trimEnd().includes("\n");
        this.firstChunk = false;
        if (notice) return [this.event("status", { text })];
        this.answerBytes += Buffer.byteLength(text);
        if (this.answerBytes > 8 * 1024 * 1024)
          throw new AcpFailure("answer_too_large", "ACP answer exceeds 8 MiB");
        this.answer += text;
        return [this.event("message", { text, payload: { delta: true } })];
      }
      case "plan":
        return [
          this.event("status", {
            plan_progress: {
              items: update.entries.map((entry, i) => ({
                id: String(i),
                title: entry.content,
                status: entry.status,
              })),
            },
          }),
        ];
      case "tool_call":
      case "tool_call_update":
        return this.tool(update, child);
      case "usage_update": {
        const amount = update.cost?.amount;
        const usd =
          update.cost?.currency === "USD" &&
          typeof amount === "number" &&
          Number.isFinite(amount) &&
          amount >= this.cost;
        const usage = usd ? { cost_usd: amount - this.cost } : {};
        if (usd) this.cost = amount;
        // used/size are context occupancy, not billable input/output tokens.
        return [
          this.event("usage", {
            usage,
            payload: {
              context_used: update.used,
              context_size: update.size,
              cost: update.cost ?? null,
            },
          }),
        ];
      }
      default:
        return []; // Every wire frame is retained by the transport.
    }
  }

  private tool(update: ToolCall | ToolCallUpdate, child: boolean): HarnessEvent[] {
    const id = update.toolCallId;
    if (typeof id !== "string" || !id)
      throw new AcpFailure("invalid_tool", "ACP tool call has no id");
    let call = this.calls.get(id);
    const events: HarnessEvent[] = [];
    if (!call) {
      if (this.calls.size >= 4096)
        throw new AcpFailure("too_many_tools", "ACP turn exceeds 4096 tool calls");
      const kinds: Record<string, ToolRef["kind"]> = {
        read: "file",
        edit: "file",
        delete: "file",
        move: "file",
        search: "search",
        execute: "command",
        fetch: "web",
      };
      call = {
        tool: {
          name: update.title ?? update.kind ?? "tool",
          kind: kinds[update.kind ?? ""] ?? "other",
          use_id: id,
        },
        terminal: false,
        child,
      };
      this.calls.set(id, call);
      if (!child) {
        this.answer = "";
        this.answerBytes = 0;
      }
      events.push(this.event("tool_call", { tool: { ...call.tool } }));
    }
    if (call.terminal) return events;
    if (update.status !== "completed" && update.status !== "failed") return events;
    call.terminal = true;
    const output = record(update.rawOutput);
    const exit = output["exitCode"] ?? output["exit_code"] ?? output["returncode"];
    const exitCode = typeof exit === "number" && Number.isInteger(exit) ? exit : undefined;
    const failed =
      update.status === "failed" ||
      output["isError"] === true ||
      output["success"] === false ||
      (exitCode !== undefined && exitCode !== 0);
    events.push(
      this.event("tool_result", {
        tool: {
          ...call.tool,
          status: failed ? "error" : "ok",
          ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
        },
      }),
    );
    for (const item of update.content ?? []) {
      if (item.type === "diff")
        events.push(
          this.event("file_change", {
            payload: { path: item.path, old_text: item.oldText, new_text: item.newText },
          }),
        );
    }
    return events;
  }

  finish(stop: string): HarnessEvent[] {
    if (stop === "cancelled") return [];
    if (stop !== "end_turn") throw new AcpFailure(stop, `ACP turn stopped: ${stop}`);
    if ([...this.calls.values()].some((call) => !call.terminal))
      throw new AcpFailure("unfinished_turn", "ACP end_turn left unfinished tool calls");
    if (!this.answer.trim())
      throw new AcpFailure("empty_answer", "ACP end_turn produced no final answer");
    return [
      this.event("message", {
        text: this.answer,
        final: true,
        payload: { final_source: "session/prompt" },
      }),
    ];
  }
}
