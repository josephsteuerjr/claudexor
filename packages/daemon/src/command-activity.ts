import { productCommandRecords } from "./command-retention.js";
import type { JobRecord } from "./job-record.js";

/** In-process project-removal/retention facts. No self-RPC, prompt copy or
 * public redaction; include the global AND every healthy project partition. */
export function commandActivityRecords(records: readonly JobRecord[]) {
  return productCommandRecords(records).map((record) => ({
    runId: record.runId,
    state: record.state,
    finishedAt: record.finishedAt,
    params: { scope: (record.params as { scope?: unknown } | null)?.scope },
  }));
}
