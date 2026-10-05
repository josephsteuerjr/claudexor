import { asObject, type CodexThreadLifecycle, type JsonObject } from "./app-server-protocol.js";

export interface CodexCancellationDeps {
  /** Resolves once the app-server child accepted its stdin. */
  spawned: Promise<void>;
  /** The root thread (`thread/start|thread/resume`); null before it is known. */
  threadId: () => string | null;
  /** The root thread's active turn; sub-agent turns never appear here. */
  activeTurnId: () => string | null;
  request: (method: string, params: JsonObject) => Promise<JsonObject>;
  readLifecycle: () => Promise<CodexThreadLifecycle>;
  stopProcess: () => Promise<void>;
  processFailure: () => Error | null;
  pollIntervalMs: number;
  cancelDeadlineMs: number;
}

/**
 * Cooperative Stop for one app-server run: pause an active goal, interrupt the
 * exact active ROOT turn, terminate only the run-owned background terminals,
 * confirm quiescence, then reap the process. `requested`, `quiescent` and
 * `failure` are the facts the run loop reads to terminalize honestly: a
 * confirmed quiescent stop is `aborted`, anything else is `codex_control_loss`.
 */
export class CodexCancellation {
  requested = false;
  quiescent = false;
  failure: Error | null = null;
  private promise: Promise<void> | null = null;

  constructor(private readonly deps: CodexCancellationDeps) {}

  /** Idempotent: every caller awaits the same cancellation. */
  readonly cancel = (): Promise<void> => {
    if (this.promise) return this.promise;
    this.requested = true;
    this.promise = (async () => {
      try {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            this.cooperative(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("Codex cooperative cancellation was not acknowledged")),
                this.deps.cancelDeadlineMs,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
      } finally {
        await this.deps.stopProcess();
        const processFailure = this.deps.processFailure();
        if (processFailure) this.failure ??= processFailure;
      }
    })();
    return this.promise;
  };

  private async cooperative(): Promise<void> {
    const { deps } = this;
    await deps.spawned;
    const threadId = deps.threadId();
    if (!threadId) return;
    const interruptedTurnIds = new Set<string>();
    for (;;) {
      const goalResult = await deps.request("thread/goal/get", { threadId });
      if (asObject(goalResult["goal"])?.["status"] === "active")
        await deps.request("thread/goal/set", { threadId, status: "paused" });
      const turnId = deps.activeTurnId();
      if (turnId && !interruptedTurnIds.has(turnId)) {
        try {
          await deps.request("turn/interrupt", { threadId, turnId });
          interruptedTurnIds.add(turnId);
        } catch (error) {
          const lifecycle = await deps.readLifecycle();
          if (!lifecycle.threadSettled && deps.activeTurnId() === turnId) throw error;
        }
      }
      let lifecycle = await deps.readLifecycle();
      for (const terminal of lifecycle.ownedBackground) {
        if (typeof terminal["processId"] !== "string") continue;
        try {
          await deps.request("thread/backgroundTerminals/terminate", {
            threadId,
            processId: terminal["processId"],
          });
        } catch (error) {
          const fresh = await deps.readLifecycle();
          if (
            fresh.ownedBackground.some(
              (candidate) => candidate["processId"] === terminal["processId"],
            )
          )
            throw error;
          lifecycle = fresh;
        }
      }
      if (lifecycle.ownedBackground.length) lifecycle = await deps.readLifecycle();
      if (
        lifecycle.threadSettled &&
        !lifecycle.goalActive &&
        lifecycle.ownedBackground.length === 0
      ) {
        this.quiescent = true;
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, deps.pollIntervalMs));
    }
  }
}
