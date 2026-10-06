import { continuationRefusal, continuationRefusalError } from "@claudexor/schema";
import type { JobRecord } from "./job-record.js";

/**
 * Daemon-atomic admission of a `continueFrom` successor (INTERFACES §1). It
 * runs synchronously inside the enqueue RPC immediately before the command is
 * accepted, so the accepted successor command IS the durable claim: journaled
 * before any spawn or adoption, shared by every ingress, and replayed with the
 * command store after a restart. Two concurrent requests are serialized by the
 * RPC loop: exactly one is accepted, the other refused with the chain head.
 */
export function admitContinuationRequest(request: unknown, records: readonly JobRecord[]): unknown {
  const refusal = continuationRefusal(request, records);
  if (refusal) throw continuationRefusalError(refusal);
  return request;
}
