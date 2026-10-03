import type { DaemonRunRecord } from "./daemon-server.js";

type ThreadRunRecord = Pick<DaemonRunRecord, "state" | "params">;

function findQueuedOrRunningThreadRun<R extends ThreadRunRecord>(
  records: readonly R[],
  threadId: string,
  mutatingOnly: boolean,
): R | undefined {
  return records.find((record) => {
    if (record.state !== "queued" && record.state !== "running") return false;
    const params =
      record.params && typeof record.params === "object"
        ? (record.params as Record<string, unknown>)
        : {};
    return params["threadId"] === threadId && (!mutatingOnly || params["mode"] === "agent");
  });
}

/** Find a queued/running thread run that can mutate its project tree. */
export function findActiveMutatingThreadRun(
  records: DaemonRunRecord[],
  threadId: string,
): DaemonRunRecord | undefined {
  return findQueuedOrRunningThreadRun(records, threadId, true);
}

/**
 * Find ANY queued/running turn of a thread, read-only modes included. Purge
 * needs this wider check: an ask/plan turn runs inside the durable lane home
 * that purge deletes (INV-034), so only an idle thread may be purged.
 */
export function findActiveThreadRun<R extends ThreadRunRecord>(
  records: readonly R[],
  threadId: string,
): R | undefined {
  return findQueuedOrRunningThreadRun(records, threadId, false);
}

export function threadIdOfRun(record: DaemonRunRecord): string | null {
  const params =
    record.params && typeof record.params === "object"
      ? (record.params as Record<string, unknown>)
      : {};
  return typeof params["threadId"] === "string" ? params["threadId"] : null;
}

export async function assertThreadIdle(
  record: DaemonRunRecord,
  listRuns: () => Promise<DaemonRunRecord[]>,
): Promise<void> {
  const threadId = threadIdOfRun(record);
  if (!threadId) return;
  const active = findActiveMutatingThreadRun(await listRuns(), threadId);
  if (active) {
    throw Object.assign(
      new Error(`thread ${threadId} has an active mutating turn (${active.state})`),
      { status: 409, code: "thread_busy" },
    );
  }
}

/** Serialize one thread mutation and retire the chain entry after settlement. */
export function chainThreadMutation<T>(
  chains: Map<string, Promise<void>>,
  threadId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(threadId) ?? Promise.resolve();
  const chained = previous.catch(() => undefined).then(work);
  const entry: Promise<void> = chained
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (chains.get(threadId) === entry) chains.delete(threadId);
    });
  chains.set(threadId, entry);
  return chained;
}

/** Existing apply/decision mutations require an idle thread but create no turn. */
export function chainIdleRunMutation<T>(
  chains: Map<string, Promise<void>>,
  daemon: { list(): Promise<DaemonRunRecord[]> },
  record: DaemonRunRecord,
  work: () => Promise<T>,
): Promise<T> {
  const threadId = threadIdOfRun(record);
  if (!threadId) return work();
  return chainThreadMutation(chains, threadId, async () => {
    await assertThreadIdle(record, () => daemon.list());
    return work();
  });
}
