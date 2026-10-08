import type { CancelReasonCode, CommandListQuery } from "@claudexor/schema";
import { delegatedParentOf } from "@claudexor/schema";

export interface DaemonRunRecord {
  promptPreview?: string;
  id: string;
  state: string;
  runId?: string;
  taskId?: string;
  runDir?: string;
  error?: string;
  errorCode?: string;
  errorStatus?: number;
  errorRetryable?: boolean;
  errorRequiredActions?: string[];
  errorContext?: Record<string, unknown>;
  params?: unknown;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DaemonFacadeClient {
  enqueue(
    params: unknown,
    options?: {
      idempotencyKey?: string;
      clientId?: string;
      idempotencyRequest?: unknown;
      operation?: string;
    },
  ): Promise<{ id: string; state: string; reused?: boolean }>;
  findAccepted?(
    params: unknown,
    options: {
      idempotencyKey: string;
      clientId?: string;
      operation?: string;
      idempotencyRequest?: unknown;
    },
  ): Promise<DaemonRunRecord | null>;
  status(id: string): Promise<DaemonRunRecord>;
  /** Required addressed selection before projection. */
  list(query: CommandListQuery): Promise<DaemonRunRecord[]>;
  cancel(id: string, reasonCode?: CancelReasonCode): Promise<unknown>;
  fenceDelegationParent?(runId: string): Promise<unknown>;
}

export interface ControlOperatorDecisionRecord {
  action: "accept_risk" | "override_needs_human";
  findingIds: string[];
  acceptedRisks: string[];
  patchSha256: string;
  decidedAt: string;
}

export function paramsRecord(record: DaemonRunRecord): Record<string, unknown> {
  return record.params && typeof record.params === "object" && !Array.isArray(record.params)
    ? (record.params as Record<string, unknown>)
    : {};
}

/** Persisted Delegate-only descendant graph; ordinary parentRunId is ignored.
 * Unlike the addressed direct-child read, the cancellation cascade this feeds
 * is deliberately UNCAPPED: every live descendant must be reachable. */
export function delegatedDescendantsFromRecords(
  parentRunId: string,
  runs: readonly DaemonRunRecord[],
): DaemonRunRecord[] {
  const children = new Map<string, DaemonRunRecord[]>();
  for (const run of runs) {
    const parent = delegatedParentOf(run.params);
    if (parent === null) continue;
    const rows = children.get(parent) ?? [];
    rows.push(run);
    children.set(parent, rows);
  }
  const out: DaemonRunRecord[] = [];
  const seen = new Set<string>([parentRunId]);
  const queue = [parentRunId];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of children.get(parent) ?? []) {
      const childRunId = child.runId ?? child.id;
      if (seen.has(childRunId)) continue;
      seen.add(childRunId);
      out.push(child);
      queue.push(childRunId);
    }
  }
  return out;
}
