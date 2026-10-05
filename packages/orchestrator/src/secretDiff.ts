import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import { AnswerAssembly, summarizeDiffPaths } from "@claudexor/core";
import type { HarnessEvent, WorkspaceEnvelope } from "@claudexor/schema";
import { createRevertAnchorFromPatchOrNull, type WorkspaceManager } from "@claudexor/workspace";
import { sensitiveResourcePolicy, sha256 } from "@claudexor/util";
import { candidateOutputSecretRisk, rasterLinksInMarkdown } from "./candidateOutputs.js";
import {
  assertPersistableText,
  buildSecretLikeFinding,
  persistedPatchCopy,
  secretLikeSummaryLine,
  type SecretLikeFinding,
} from "./persistedPatch.js";

/** The candidate's changes could not be observed at all. This is the ONLY
 * capture-time refusal left: secret-like content is never one (INV-062). */
export interface CaptureRefusal {
  disposition: "discarded" | "manual_cleanup";
  detail: string;
  /** Failure phase; a directory result keeps its sensitive-resource phase. */
  phase?: "workspace" | "artifact_security";
}

export function recordCaptureRefusal(
  refusal: CaptureRefusal | undefined,
  errors: string[],
  existingError: boolean,
): boolean {
  if (!refusal) return existingError;
  errors.push(refusal.detail);
  return true;
}

export function captureRefusalNextActions(refusal: CaptureRefusal): string[] {
  return refusal.disposition === "manual_cleanup"
    ? ["Inspect the changed files in the project folder directly", "Retry the run"]
    : ["Retry the run"];
}

/** Answer assembly that also counts secret-like matches in answer material
 * BEFORE its first redaction. Harness events are redacted one by one on their
 * way into the assembly, so a count taken on the assembled answer would
 * always read zero. The count mirrors the assembly's own selection: a typed
 * final wins verbatim, otherwise the narration parts add up. */
export class CountedAnswerAssembly extends AnswerAssembly {
  private finalMatches: number | null = null;
  private partMatches = 0;

  observeCounted(raw: HarnessEvent, safe: HarnessEvent): void {
    this.observe(safe);
    if (raw.type !== "message" || !raw.text) return;
    const payload = raw.payload ?? {};
    if (payload["auth_switched"] === true || payload["delta"] === true) return;
    if (payload["buffered"] === true) return;
    const matches = sensitiveResourcePolicy.inspectContent(raw.text, "redact").matches;
    if (raw.final !== true) this.partMatches += matches;
    else if (raw.text.trim().length > 0) this.finalMatches = matches;
  }

  secretLikeMatches(): number {
    return this.hasFinal() && this.finalMatches !== null ? this.finalMatches : this.partMatches;
  }
}

/** Read-only products have no patch or media findings. Their selected answer's
 * pre-redaction count uses the same disclosure shape as a candidate capture. */
export function answerSecretLikeFinding(answerMatches = 0): SecretLikeFinding | undefined {
  return buildSecretLikeFinding({
    copy: { text: "", files: [], unattributedMatches: 0 },
    binaryPaths: [],
    mediaWithheld: [],
    answerMatches,
  });
}

export interface CandidateCapture {
  /** The EXACT candidate patch: apply, synthesis, digests and gates read it. */
  diff: string;
  /** The saved copy, present only when it differs from the exact patch. */
  persistedDiff?: string;
  secretLike?: SecretLikeFinding;
  captureRefusal?: CaptureRefusal;
  /** Set when the private exact patch object of an isolated candidate could
   * not be written: its envelope is kept and this is where the bytes still are. */
  exactBytesRetainedAt?: string;
}

/** Disclosure fields of one attempt record (`attempt.yaml`). */
export function attemptDisclosure(capture: CandidateCapture): Record<string, unknown> {
  return {
    ...(capture.captureRefusal ? { capture_refusal: capture.captureRefusal } : {}),
    ...(capture.secretLike ? { secret_like: capture.secretLike } : {}),
    ...(capture.exactBytesRetainedAt
      ? { exact_bytes_retained_at: capture.exactBytesRetainedAt }
      : {}),
  };
}

/**
 * Capture a candidate's changes and classify what a SAVED copy must hide.
 * Nothing is rolled back, discarded or failed for secret-like content: the
 * tree, the in-memory diff and the reviewer's verdict all keep the real bytes.
 */
export async function captureCandidateWorkspace(input: {
  wsm: WorkspaceManager;
  envelope: WorkspaceEnvelope;
  inPlace: boolean;
  /** Project root owning the private exact patch object store. */
  projectRoot: string;
  answerText?: string;
  answerMatches: number;
}): Promise<CandidateCapture> {
  const { wsm, envelope, inPlace } = input;
  let captured;
  try {
    captured = await wsm.captureDiff(envelope);
  } catch (error) {
    const scratchCleanupUnproven =
      error instanceof Error && Object.prototype.hasOwnProperty.call(error, "cleanupError");
    return refused(
      inPlace || scratchCleanupUnproven ? "manual_cleanup" : "discarded",
      scratchCleanupUnproven
        ? "candidate output capture failed and private scratch cleanup could not be proven; manual cleanup of Claudexor temporary state is required"
        : inPlace
          ? "candidate output could not be captured; the changed files are untouched and need direct inspection"
          : "uncaptured isolated candidate output was discarded with the candidate envelope",
    );
  }
  if (captured.captureIncomplete) {
    return refused(
      inPlace ? "manual_cleanup" : "discarded",
      inPlace
        ? "candidate output could not be captured as a complete patch; the changed files are untouched and need direct inspection"
        : "uncaptured isolated candidate output was discarded with the candidate envelope",
    );
  }
  const media = candidateOutputSecretRisk({
    worktreePath: envelope.worktree_path,
    changedPaths: [
      ...summarizeDiffPaths(captured.diff).paths,
      ...rasterLinksInMarkdown(input.answerText ?? ""),
    ],
    artifactRelativeDir: wsm.ownedArtifactRelativeDirectory(envelope),
  });
  const copy = persistedPatchCopy(captured.diff, captured.binarySecretPaths);
  const secretLike = buildSecretLikeFinding({
    copy,
    binaryPaths: captured.binarySecretPaths,
    mediaWithheld: [
      ...media.riskyPaths,
      ...(media.artifactDirectoryUnsafe
        ? [wsm.ownedArtifactRelativeDirectory(envelope) ?? ""]
        : []),
    ].filter(Boolean),
    answerMatches: input.answerText ? input.answerMatches : 0,
  });
  const redactedCopy = copy.text !== captured.diff;
  // An isolated candidate's envelope is the only other holder of the exact
  // bytes and is about to be removed, so its exact object is written NOW. If
  // that write fails the envelope is kept: a deferred Apply then refuses typed
  // while the bytes, the answer and the run state stay readable.
  const retained =
    redactedCopy &&
    !inPlace &&
    createRevertAnchorFromPatchOrNull(input.projectRoot, captured.diff) === null;
  if (retained) wsm.retainEnvelope(envelope);
  return {
    diff: captured.diff,
    ...(redactedCopy ? { persistedDiff: copy.text } : {}),
    ...(secretLike ? { secretLike } : {}),
    ...(retained ? { exactBytesRetainedAt: envelope.worktree_path } : {}),
  };
}

function refused(disposition: CaptureRefusal["disposition"], detail: string): CandidateCapture {
  return { diff: "", captureRefusal: { disposition, detail } };
}

/**
 * Write a run's final patch: the saved copy to `final/patch.diff`, the exact
 * bytes to the private exact patch object when the copy hides anything, and
 * the disclosure fields for `work_product.yaml` meta. `patchSha256` is ALWAYS
 * the digest of the exact patch, so a redacted copy can never pass the apply
 * gate's digest binding on any route.
 */
export function persistFinalPatch(
  store: ArtifactStore,
  finalDir: string,
  run: Pick<CandidateCapture, "diff" | "persistedDiff" | "secretLike" | "exactBytesRetainedAt">,
): { patchSha256: string; meta: Record<string, unknown> } {
  const copy = run.persistedDiff ?? persistedPatchCopy(run.diff, []).text;
  assertPersistableText("final patch copy", copy);
  store.writeText(join(finalDir, "patch.diff"), copy);
  const meta: Record<string, unknown> = run.secretLike ? { secret_like: run.secretLike } : {};
  if (copy !== run.diff) {
    meta["persisted_patch"] = "redacted";
    // null: the exact bytes could not be stored; a deferred Apply answers
    // patch_exact_bytes_unavailable instead of applying the copy.
    const exactObject = createRevertAnchorFromPatchOrNull(store.repoRoot, run.diff);
    meta["exact_patch_object"] = exactObject;
    if (exactObject === null && run.exactBytesRetainedAt) {
      meta["exact_bytes_retained_at"] = run.exactBytesRetainedAt;
    }
  }
  return { patchSha256: sha256(run.diff), meta };
}

export { secretLikeSummaryLine };

/** `\n`-prefixed disclosure line for a summary template; "" when clean. */
export function summaryDisclosure(finding: SecretLikeFinding | undefined): string {
  const line = secretLikeSummaryLine(finding);
  return line ? `\n${line}` : "";
}
