import type { HarnessEvent } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import { asObject, codexAppServerEvents, type JsonObject } from "./app-server-protocol.js";
import { parseCodexEvent, type CodexParseState } from "./parse.js";

/**
 * Root-thread ownership of Codex app-server notifications.
 *
 * Codex (0.156.x, proactive multi-agent mode) may spawn sub-agents whose
 * threads carry their own `threadId`, and every frame of those threads arrives
 * on the SAME stdio stream as the root thread's. Only the root thread — the one
 * `thread/start`/`thread/resume` returned — owns finality: its `turn/started`
 * resets the pending final, its `turn/completed` is the terminal candidate, its
 * last agent message is the answer, and its `thread/status/changed systemError`
 * fails the run. Ownership is per THREAD, never per turn: a goal continuation
 * legitimately runs several root turns in one run. A frame without a
 * `threadId` (older shapes, `thread/started`) is the root's once the root is
 * known. Before binding, notifications must wait for classification.
 */
export function notificationThreadId(params: JsonObject | null): string | null {
  const threadId = params?.["threadId"];
  return typeof threadId === "string" ? threadId : null;
}

export function ownsNotification(params: JsonObject | null, rootThreadId: string | null): boolean {
  const threadId = notificationThreadId(params);
  return rootThreadId !== null && (threadId === null || threadId === rootThreadId);
}

/** Sub-agent lifecycle frames: recognized (never "dropped"), never finality. */
const SUBAGENT_LIFECYCLE_METHODS = new Set([
  "turn/started",
  "turn/completed",
  "thread/started",
  "thread/status/changed",
  "mcpServer/startupStatus/updated",
]);

/**
 * Sub-agent thread traffic projected for the timeline. Tool calls/results,
 * thinking, file changes and token usage stay (so the run's cost counts every
 * thread) tagged with the originating thread; agent TEXT is re-emitted as a
 * `status` event (`code: subagent_message`) and never as a `message`, so the
 * answer assembly can never take a sub-agent as the author of the final — the
 * same rule the claude adapter applies to `parent_tool_use_id` frames. Plan
 * progress of a sub-agent never overwrites the root's plan.
 */
export class CodexSubagentThreads {
  private readonly states = new Map<string, CodexParseState>();

  /** Distinct sub-agent threads observed so far (disclosed on the terminal). */
  get count(): number {
    return this.states.size;
  }

  /** `null` = unrecognized frame (counted as dropped by the run loop). */
  events(notification: JsonObject, sessionId: string): HarnessEvent[] | null {
    const method = notification["method"];
    const params = asObject(notification["params"]);
    const threadId = notificationThreadId(params) ?? "";
    let state = this.states.get(threadId);
    if (!state) {
      state = { envelopeActive: false, startedEmitted: true };
      this.states.set(threadId, state);
    }
    if (typeof method === "string" && SUBAGENT_LIFECYCLE_METHODS.has(method)) return [];
    const mapped = codexAppServerEvents(notification, sessionId, state);
    if (!mapped) return null;
    const turnId = params?.["turnId"];
    const tag: JsonObject = {
      native_thread_id: threadId,
      ...(typeof turnId === "string" ? { native_turn_id: turnId } : {}),
      subagent: true,
    };
    return mapped.map((event) => {
      const { final: _final, plan_progress: _plan, ...rest } = event;
      const payload = { ...(event.payload ?? {}), ...tag };
      if (event.type !== "message") return { ...rest, payload };
      return { ...rest, type: "status", payload: { ...payload, code: "subagent_message" } };
    });
  }
}

/**
 * The terminal events for the root thread once it settled: a failed turn, a
 * durable systemError, or the completed turn whose last agent message is the
 * typed final. `reportedError` is the harness-reported-error verdict the
 * terminal implies (null = leave the run's flag untouched).
 */
export function codexTerminalEvents(input: {
  pendingTerminal: JsonObject | null;
  systemError: boolean;
  sessionId: string;
  parseState: CodexParseState;
}): { events: HarnessEvent[]; reportedError: boolean | null } {
  const status = input.pendingTerminal?.["status"];
  if (status === "failed") {
    const error = asObject(input.pendingTerminal?.["error"]);
    const failed = parseCodexEvent(
      { type: "turn.failed", error: { message: error?.["message"] ?? "turn failed" } },
      input.sessionId,
      input.parseState,
    );
    if (!failed) return { events: [], reportedError: null };
    return { events: failed, reportedError: failed.some((event) => event.type === "error") };
  }
  if (input.systemError) {
    return {
      events: [
        {
          type: "error",
          session_id: input.sessionId,
          ts: nowIso(),
          error: "Codex app-server thread settled in systemError",
          payload: { code: "codex_app_server_failure" },
        },
      ],
      reportedError: true,
    };
  }
  if (status === "completed") {
    const final = parseCodexEvent(
      { type: "turn.completed", usage: {} },
      input.sessionId,
      input.parseState,
    );
    return {
      events: final ? final.filter((event) => event.type !== "usage") : [],
      reportedError: null,
    };
  }
  return { events: [], reportedError: null };
}
