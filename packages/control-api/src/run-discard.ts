/**
 * The `discard` decision (POST /v2/runs/:id/decision): explicitly give up a
 * terminal run's result that is still held for the operator — a pending
 * copied-files result (INV-111) or a stopped run's isolated envelope retained
 * for `continueFrom` (A9). Direct effects already in place are never undone.
 */
import { ControlRunDecisionResponse } from "@claudexor/schema";
import { releaseRetainedEnvelope, retainedEnvelopeOfRun } from "@claudexor/workspace";
import { readFilesWorkProduct } from "./files-work-product.js";
import { appendRunAuditEvent } from "./run-audit.js";
import { controlRunResult, markRunApplyState } from "./run-delivery-state.js";
import type { DaemonRunRecord } from "./run-record.js";
import { TERMINAL_STATES } from "./sse-shared.js";

export async function discardRunResult(rec: DaemonRunRecord): Promise<ControlRunDecisionResponse> {
  const retained =
    TERMINAL_STATES.has(rec.state) && rec.runDir && rec.runId
      ? retainedEnvelopeOfRun(rec.runDir, rec.runId)
      : null;
  if (retained) {
    await releaseRetainedEnvelope(retained);
    appendRunAuditEvent(rec, "control.applied", {
      decision: "discard",
      retained_envelope: retained.envelope.worktree_path,
    });
    return ControlRunDecisionResponse.parse({
      accepted: true,
      status: "discarded",
      message:
        "Stopped work discarded; its kept envelope was removed and the run can no longer be continued.",
    });
  }
  const files = readFilesWorkProduct(rec);
  const state = controlRunResult(rec).applyState;
  if (
    !TERMINAL_STATES.has(rec.state) ||
    !files ||
    files.manifest.isolation !== "envelope" ||
    (state !== "not_applied" && state !== "discarded")
  )
    throw Object.assign(
      new Error(
        "Only an unapplied copied files result or a kept stopped run can be discarded; direct effects remain in place",
      ),
      { status: 409 },
    );
  markRunApplyState(rec, "discarded", undefined, true);
  appendRunAuditEvent(rec, "control.applied", {
    decision: "discard",
    manifest_sha256: files.manifestSha256,
  });
  return ControlRunDecisionResponse.parse({
    accepted: true,
    status: "discarded",
    message: "Pending file application discarded; retained result follows normal retention.",
  });
}
