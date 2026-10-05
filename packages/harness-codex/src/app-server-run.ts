import { spawnProcess, type ChildStdin, type SpawnOptions } from "@claudexor/core";
import type { EffortHint, HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { codexAppServerInput } from "./attachments.js";
import {
  asObject,
  CodexAppServerController,
  codexAppServerEvents,
  codexAppServerThreadParams,
  codexRequestRefusal,
  createCodexSteer,
  errorText,
  readCodexLifecycle,
  rpcProvenance,
  type CodexThreadLifecycle,
  type JsonObject,
} from "./app-server-protocol.js";
import { CodexCancellation } from "./app-server-cancel.js";
import {
  CodexSubagentThreads,
  codexTerminalEvents,
  ownsNotification,
} from "./app-server-threads.js";
import { parseCodexStderrFailure, type CodexParseState } from "./parse.js";
import { parseCodexRpcError } from "./rpc-error.js";

export { CodexAppServerController } from "./app-server-protocol.js";
export { codexAppServerEvents, codexAppServerThreadParams } from "./app-server-protocol.js";
export interface CodexAppServerRunInput {
  bin: string;
  args: string[];
  spec: HarnessRunSpec;
  env: Record<string, string | null | undefined>;
  spawn?: typeof spawnProcess;
  controller?: CodexAppServerController;
  /** The run's ONE effort receipt (`submitted`); resolved from the snapshot when absent. */
  effort?: EffortHint | null;
  pollIntervalMs?: number;
  cancelDeadlineMs?: number;
  /** Bound on the vendor's `turn/steer` answer (default 30 s); see createCodexSteer. */
  steerDeadlineMs?: number;
}

export async function* runCodexAppServer(
  input: CodexAppServerRunInput,
): AsyncGenerator<HarnessEvent> {
  const run = input.spawn ?? spawnProcess;
  const abort = new AbortController();
  const pending = new Map<
    number,
    { resolve: (value: JsonObject) => void; reject: (error: Error) => void; taint: boolean }
  >();
  const notifications: JsonObject[] = [];
  const notificationWaiter: { wake?: () => void } = {};
  let io: ChildStdin | null = null;
  let resolveSpawn!: () => void;
  const spawned = new Promise<void>((resolve) => {
    resolveSpawn = resolve;
  });
  let nextId = 1;
  let processFailure: Error | null = null;
  let processStopped = false;
  let nativeThreadId: string | null = input.spec.resume_session_id ?? null;
  let activeTurnId: string | null = null;
  const ownedCommandItemIds = new Set<string>();
  const subagents = new CodexSubagentThreads();
  // Declared before the transport so its state is readable from the process
  // teardown; the request/lifecycle/stop seams below are reached lazily.
  const cancellation = new CodexCancellation({
    spawned,
    threadId: () => nativeThreadId,
    activeTurnId: () => activeTurnId,
    request: (method, params) => request(method, params),
    readLifecycle: () => readLifecycle(),
    stopProcess: () => stopProcess(),
    processFailure: () => processFailure,
    pollIntervalMs: input.pollIntervalMs ?? 250,
    cancelDeadlineMs: input.cancelDeadlineMs ?? 5_000,
  });
  const stderrRing: string[] = [];
  let launchAdvisory: string | null = null;
  let launchAdvisoryShown = false;
  let droppedUnrecognizedEvents = 0;
  let harnessReportedError = false;
  let terminationUnconfirmed: { survivors: number[]; unresolved: JsonObject[] } | null = null;
  let nativeSystemError = false;
  const requiredMcpStatuses = new Map<
    string,
    { status: "starting" | "ready" | "failed" | "cancelled"; error?: string }
  >(
    input.spec.extra_mcp_servers
      .filter((server) => server.required)
      .map((server) => [server.name, { status: "starting" }] as const),
  );
  const parseState: CodexParseState = {
    envelopeActive: input.spec.output_schema !== undefined && input.spec.output_schema !== null,
    requiredMcpServers: input.spec.extra_mcp_servers
      .filter((server) => server.required)
      .map((server) => server.name),
    startedEmitted: true,
  };

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  // Root-thread state only (app-server-threads.ts): a sub-agent thread's frames
  // never move the active turn, the owned command set, or the thread's health.
  const observeOwnNotification = (notification: JsonObject): void => {
    const method = notification["method"];
    const params = asObject(notification["params"]);
    if (!ownsNotification(params, nativeThreadId)) return;
    if (method === "turn/started") {
      const turn = asObject(params?.["turn"]);
      if (typeof turn?.["id"] === "string") activeTurnId = turn["id"];
    } else if (method === "turn/completed") {
      const turn = asObject(params?.["turn"]);
      if (!turn || turn["id"] === activeTurnId) activeTurnId = null;
    } else if (method === "item/started") {
      const item = asObject(params?.["item"]);
      if (item?.["type"] === "commandExecution" && typeof item["id"] === "string")
        ownedCommandItemIds.add(item["id"]);
    } else if (method === "thread/status/changed") {
      if (asObject(params?.["status"])?.["type"] === "systemError") nativeSystemError = true;
    } else if (method === "mcpServer/startupStatus/updated") {
      const name = params?.["name"];
      const status = params?.["status"];
      if (
        typeof name === "string" &&
        requiredMcpStatuses.has(name) &&
        (status === "starting" ||
          status === "ready" ||
          status === "failed" ||
          status === "cancelled")
      ) {
        const error = params?.["error"] ?? params?.["failureReason"];
        requiredMcpStatuses.set(name, {
          status,
          ...(typeof error === "string" ? { error } : {}),
        });
        if (status === "failed" || status === "cancelled") harnessReportedError = true;
      }
    }
  };
  const onMessage = (message: unknown): void => {
    const object = asObject(message);
    if (!object) throw new Error("Codex app-server sent a non-object JSON-RPC frame");
    if (typeof object["id"] === "number") {
      const request = pending.get(object["id"]);
      if (!request) return;
      pending.delete(object["id"]);
      const rpcError = asObject(object["error"]);
      if (rpcError) {
        if (request.taint) harnessReportedError = true;
        request.reject(parseCodexRpcError(rpcError));
        return;
      }
      const result = asObject(object["result"]);
      if (!result) {
        request.reject(new Error("Codex app-server returned a malformed JSON-RPC result"));
        return;
      }
      request.resolve(result);
      return;
    }
    if (typeof object["method"] === "string") {
      observeOwnNotification(object);
      steer.observeEcho(object);
      notifications.push(object);
      notificationWaiter.wake?.();
      notificationWaiter.wake = undefined;
    }
  };

  const process = (async (): Promise<void> => {
    try {
      const options: SpawnOptions = {
        cwd: input.spec.cwd,
        env: input.env,
        inheritEnv: input.spec.env_inheritance,
        keepStdinOpen: true,
        abortSignal: abort.signal,
        onSpawn(childIo) {
          io = childIo;
          resolveSpawn();
        },
      };
      for await (const event of run(input.bin, [...input.args, "app-server", "--stdio"], options)) {
        if (event.type === "stdout") {
          try {
            onMessage(JSON.parse(event.line));
          } catch (error) {
            throw new Error(`Invalid Codex app-server frame: ${errorText(error)}`);
          }
        } else if (event.type === "launch_advisory") {
          launchAdvisory = event.detail;
        } else if (event.type === "stderr") {
          stderrRing.push(event.line);
          if (stderrRing.length > 40) stderrRing.shift();
        } else if (event.type === "termination_unconfirmed") {
          terminationUnconfirmed = {
            survivors: event.survivors,
            unresolved: event.unresolved,
          };
          throw new Error("Codex app-server process termination could not be confirmed");
        } else if (event.type === "exit" && !abort.signal.aborted) {
          throw new Error(
            `Codex app-server exited before the run completed (code ${event.code ?? "null"})`,
          );
        }
      }
    } catch (error) {
      processFailure = error instanceof Error ? error : new Error(String(error));
      rejectPending(processFailure);
      throw processFailure;
    } finally {
      processStopped = true;
      if (abort.signal.aborted)
        rejectPending(cancellation.failure ?? new Error("Codex app-server stopped"));
      notificationWaiter.wake?.();
      notificationWaiter.wake = undefined;
    }
  })();
  void process.catch(() => {});

  // `taint`: a refused request marks the run harness_reported_error; a live
  // message (turn/steer) passes false so a benign refusal never poisons the run.
  const request = async (method: string, params: JsonObject, taint = true): Promise<JsonObject> => {
    await Promise.race([
      spawned,
      process.then(() => {
        throw processFailure ?? new Error("Codex app-server exited before accepting requests");
      }),
    ]);
    const id = nextId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      pending.set(id, { resolve, reject, taint });
    });
    io!.write(`${JSON.stringify({ id, method, params })}\n`);
    return response;
  };
  const notify = async (method: string, params: JsonObject | null): Promise<void> => {
    await spawned;
    io!.write(`${JSON.stringify({ method, params })}\n`);
  };
  const steer = createCodexSteer({
    sessionId: input.spec.session_id,
    threadId: () => nativeThreadId,
    activeTurnId: () => activeTurnId,
    live: () => !cancellation.requested && !processStopped,
    send: (method, params) => rpcProvenance(request(method, params, false)),
    responseDeadlineMs: input.steerDeadlineMs ?? 30_000,
  });
  const nextNotification = async (
    method: string,
    accept: (params: JsonObject | null) => boolean = () => true,
    consume = true,
  ): Promise<JsonObject> => {
    for (;;) {
      const index = notifications.findIndex(
        (item) => item["method"] === method && accept(asObject(item["params"])),
      );
      if (index >= 0) return consume ? notifications.splice(index, 1)[0]! : notifications[index]!;
      if (processFailure) throw processFailure;
      await new Promise<void>((resolve) => {
        notificationWaiter.wake = resolve;
      });
    }
  };
  /** Next queued notification; with `timeoutMs`, `null` once the wait lapses in silence. */
  const takeNotification = async (timeoutMs?: number): Promise<JsonObject | null> => {
    for (;;) {
      const next = notifications.shift();
      if (next) return next;
      if (processFailure) throw processFailure;
      if (processStopped) throw cancellation.failure ?? new Error("Codex app-server disconnected");
      const woke = await new Promise<boolean>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        notificationWaiter.wake = () => {
          if (timer) clearTimeout(timer);
          resolve(true);
        };
        if (timeoutMs !== undefined)
          timer = setTimeout(() => {
            notificationWaiter.wake = undefined;
            resolve(false);
          }, timeoutMs);
      });
      if (!woke) return null;
    }
  };
  const waitForRequiredMcp = async (): Promise<void> => {
    while (requiredMcpStatuses.size) {
      const failed = [...requiredMcpStatuses].filter(
        ([, value]) => value.status === "failed" || value.status === "cancelled",
      );
      if (failed.length) {
        throw new Error(
          `required MCP servers failed to initialize: ${failed
            .map(([name, value]) => `${name}: ${value.error ?? value.status}`)
            .join(", ")}`,
        );
      }
      if ([...requiredMcpStatuses.values()].every((value) => value.status === "ready")) return;
      await nextNotification("mcpServer/startupStatus/updated");
    }
  };
  let stopPromise: Promise<void> | null = null;
  const stopProcess = (): Promise<void> => {
    stopPromise ??= (async () => {
      if (!abort.signal.aborted) abort.abort();
      io?.end();
      await process.catch(() => {});
    })();
    return stopPromise;
  };
  const terminalPayload = (extra: JsonObject = {}): JsonObject => {
    const stderrTail = redactSecrets(stderrRing.join("\n")).slice(-1_000).trim();
    return {
      ...extra,
      ...(launchAdvisory && !launchAdvisoryShown
        ? { launch_advisory: redactSecrets(launchAdvisory) }
        : {}),
      ...(harnessReportedError ? { harness_reported_error: true } : {}),
      ...(stderrTail ? { stderr_tail: stderrTail } : {}),
      ...(droppedUnrecognizedEvents
        ? { dropped_unrecognized_events: droppedUnrecognizedEvents }
        : {}),
      ...(terminationUnconfirmed ? { termination_unconfirmed: terminationUnconfirmed } : {}),
    };
  };
  const readLifecycle = (): Promise<CodexThreadLifecycle> =>
    readCodexLifecycle(request, nativeThreadId, ownedCommandItemIds);
  const { cancel } = cancellation;
  input.controller?.bind(cancel);
  input.controller?.bindSteer(steer.send);
  const onAbort = (): void => void cancel();
  const externalAbort = input.spec.extra["abortSignal"];
  if (externalAbort instanceof AbortSignal) {
    if (externalAbort.aborted) onAbort();
    else externalAbort.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await request("initialize", {
      clientInfo: { name: "claudexor", version: CLAUDEXOR_VERSION },
      capabilities: { experimentalApi: true },
    });
    await notify("initialized", null);
    const threadResult = await request(
      input.spec.resume_session_id ? "thread/resume" : "thread/start",
      input.spec.resume_session_id
        ? {
            ...codexAppServerThreadParams(input.spec, input.effort),
            threadId: input.spec.resume_session_id,
          }
        : codexAppServerThreadParams(input.spec, input.effort),
    );
    const thread = asObject(threadResult["thread"]);
    const threadId = thread?.["id"];
    if (typeof threadId !== "string") throw new Error("Codex app-server omitted thread id");
    const rootWasUnknown = nativeThreadId === null;
    nativeThreadId = threadId;
    // Nothing has consumed this queue yet. Classify startup state effects in
    // arrival order now that start named the root; resume was bound upfront.
    if (rootWasUnknown) notifications.forEach(observeOwnNotification);
    await waitForRequiredMcp();
    const turnResult = await request("turn/start", {
      threadId,
      input: codexAppServerInput(input.spec),
      ...(input.spec.output_schema !== undefined && input.spec.output_schema !== null
        ? { outputSchema: input.spec.output_schema }
        : {}),
    });
    // The turn THIS run started is the RPC result's turn; the root thread's
    // matching `turn/started` is awaited so the adapter state (activeTurnId)
    // is primed. A sub-agent turn queued meanwhile (a resumed plan-review
    // thread may re-engage an earlier child) never satisfies the wait.
    const requestedTurnId = asObject(turnResult["turn"])?.["id"];
    const started = await nextNotification(
      "turn/started",
      (params) =>
        ownsNotification(params, threadId) &&
        (typeof requestedTurnId !== "string" ||
          asObject(params?.["turn"])?.["id"] === requestedTurnId),
      // Keep the start in timeline order: an earlier root completion must see
      // the new turn queued before it can become the terminal candidate.
      false,
    );
    const turnId =
      typeof requestedTurnId === "string"
        ? requestedTurnId
        : asObject(asObject(started["params"])?.["turn"])?.["id"];
    if (typeof turnId !== "string") throw new Error("Codex app-server omitted active turn id");
    yield {
      type: "started",
      session_id: input.spec.session_id,
      ts: nowIso(),
      payload: {
        native_session_id: threadId,
        native_turn_id: turnId,
        ...(parseState.requiredMcpServers?.length
          ? {
              mcp_servers: parseState.requiredMcpServers.map((name) => ({
                name,
                status: "connected",
              })),
            }
          : {}),
      },
    };
    if (launchAdvisory) {
      yield {
        type: "status",
        session_id: input.spec.session_id,
        ts: nowIso(),
        text: redactSecrets(launchAdvisory),
        payload: { launch_advisory: true },
      };
      launchAdvisoryShown = true;
    }
    let pendingTerminal: JsonObject | null = null;
    for (;;) {
      // Once the root turn completed, "thread settled" is re-checked on ANY
      // notification and, as a safety net, after the poll interval even in
      // silence (how Codex reports the root status while sub-agents still
      // run is not verified).
      const notification = pendingTerminal
        ? await takeNotification(input.pollIntervalMs ?? 250)
        : await takeNotification();
      if (notification) {
        const method = notification["method"];
        const params = asObject(notification["params"]);
        if (!ownsNotification(params, nativeThreadId)) {
          // A sub-agent thread: timeline and usage only, never finality.
          const mapped = subagents.events(notification, input.spec.session_id);
          if (mapped) for (const event of mapped) yield event;
          else droppedUnrecognizedEvents += 1;
          if (!pendingTerminal) continue;
        } else if (method === "turn/started") {
          pendingTerminal = null;
          parseState.lastAgentMessage = undefined;
          continue;
        } else {
          const mapped =
            steer.deliveredEvents(notification) ??
            codexAppServerEvents(notification, input.spec.session_id, parseState);
          if (mapped) {
            for (const event of mapped) {
              if (event.type === "error") harnessReportedError = true;
              yield event;
            }
          } else if (
            method !== "turn/completed" &&
            method !== "thread/status/changed" &&
            method !== "mcpServer/startupStatus/updated"
          ) {
            droppedUnrecognizedEvents += 1;
          }
          if (method === "turn/completed") {
            pendingTerminal = asObject(params?.["turn"]);
          } else if (method === "thread/status/changed" && nativeSystemError && !pendingTerminal) {
            pendingTerminal = {
              id: activeTurnId,
              status: "failed",
              error: { message: "Codex app-server thread settled in systemError" },
            };
          } else if (!pendingTerminal) {
            continue;
          }
        }
      }

      for (;;) {
        const current =
          cancellation.requested && cancellation.quiescent
            ? {
                threadStatus: "idle",
                threadSettled: true,
                goalActive: false,
                ownedBackground: [],
              }
            : await readLifecycle();
        if (
          !nativeSystemError &&
          notifications.some(
            (item) =>
              item["method"] === "turn/started" &&
              ownsNotification(asObject(item["params"]), nativeThreadId),
          )
        )
          break;
        const systemError = nativeSystemError || current.threadStatus === "systemError";
        if (!current.threadSettled || current.goalActive || current.ownedBackground.length) {
          if (systemError && current.ownedBackground.length) {
            await new Promise<void>((resolve) => setTimeout(resolve, input.pollIntervalMs ?? 250));
            continue;
          }
          if (!systemError && current.ownedBackground.length && !current.goalActive) {
            await new Promise<void>((resolve) => setTimeout(resolve, input.pollIntervalMs ?? 250));
            continue;
          }
          if (!systemError) break;
        }
        const status = pendingTerminal?.["status"];
        const terminal = codexTerminalEvents({
          pendingTerminal,
          systemError,
          sessionId: input.spec.session_id,
          parseState,
        });
        if (terminal.reportedError !== null) harnessReportedError = terminal.reportedError;
        await stopProcess();
        if (processFailure) throw processFailure;
        for (const event of terminal.events) yield event;
        yield {
          type: "completed",
          session_id: input.spec.session_id,
          ts: nowIso(),
          ...(status === "interrupted" ? { aborted: true } : {}),
          payload: terminalPayload({
            native_session_id: threadId,
            // The last ROOT turn: sub-agent turns never become the terminal.
            native_turn_id: pendingTerminal?.["id"] ?? activeTurnId,
            ...(subagents.count ? { subagent_threads: subagents.count } : {}),
          }),
        };
        return;
      }
    }
  } catch (error) {
    await stopProcess();
    if (processFailure && cancellation.requested) cancellation.failure ??= processFailure;
    if (
      cancellation.requested &&
      cancellation.quiescent &&
      !cancellation.failure &&
      !processFailure
    ) {
      yield {
        type: "completed",
        session_id: input.spec.session_id,
        ts: nowIso(),
        aborted: true,
        payload: terminalPayload({ code: "user_cancelled", native_session_id: nativeThreadId }),
      };
      return;
    }
    const aborted = cancellation.requested;
    const failure = processFailure ?? cancellation.failure ?? error;
    const requestRefusal = codexRequestRefusal(failure);
    const code =
      cancellation.failure || terminationUnconfirmed
        ? "codex_control_loss"
        : "codex_app_server_failure";
    const nativeError =
      !requestRefusal && failure !== processFailure && !cancellation.failure
        ? parseCodexStderrFailure(errorText(failure), input.spec.session_id, parseState)
        : null;
    if (nativeError) harnessReportedError = true;
    yield nativeError ?? {
      type: "error",
      session_id: input.spec.session_id,
      ts: nowIso(),
      error: redactSecrets(errorText(failure)),
      ...(requestRefusal ? { request_refusal: requestRefusal } : {}),
      payload: { code: requestRefusal?.kind ?? code },
    };
    yield {
      type: "completed",
      session_id: input.spec.session_id,
      ts: nowIso(),
      ...(aborted ? { aborted: true } : {}),
      payload: terminalPayload({ code, native_session_id: nativeThreadId }),
    };
  } finally {
    if (externalAbort instanceof AbortSignal) externalAbort.removeEventListener("abort", onAbort);
    input.controller?.clear(cancel);
    input.controller?.clearSteer(steer.send);
    await stopProcess();
  }
}
