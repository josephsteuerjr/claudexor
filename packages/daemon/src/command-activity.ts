import { productCommandRecords } from "./command-retention.js";
import type { JobRecord } from "./job-record.js";

/** In-process project-removal/retention facts. No self-RPC, prompt copy or
 * public redaction; include the global AND every healthy project partition.
 * Project removal reads `scope`; the retention trash fence reads `threadId`. */
export function commandActivityRecords(records: readonly JobRecord[]) {
  return productCommandRecords(records).map((record) => {
    const params = record.params as { scope?: unknown; threadId?: unknown } | null;
    return {
      runId: record.runId,
      state: record.state,
      finishedAt: record.finishedAt,
      params: { scope: params?.scope, threadId: params?.threadId },
    };
  });
}
