import { EXACT_PATCH_UNAVAILABLE_MESSAGE } from "@claudexor/delivery";
import { WorkProduct } from "@claudexor/schema";
import { sha256 } from "@claudexor/util";
import { PATCH_EXACT_BYTES_UNAVAILABLE, resolveExactPatch } from "@claudexor/workspace";
import { readRawTextArtifact, safeReadStructuredArtifact } from "./run-artifact-read.js";
import { recordedExecutionRoot } from "./run-delivery-state.js";
import type { DaemonRunRecord } from "./run-record.js";

/**
 * The ONE interpretation point for a run's saved patch (INV-062).
 *
 * `final/patch.diff` is byte-exact unless the work product says
 * `persisted_patch: redacted`; then it is a display-only copy with secret-like
 * strings hidden and every consumer that applies, checks, hashes or binds a
 * decision to "the patch" must read the private exact patch object instead.
 * `unavailable` means that object is missing or corrupt: `patch` then still
 * holds the saved copy for display, and nothing may be applied from it.
 */
export function resolveRunPatch(
  rec: DaemonRunRecord,
  projectRoot: string | null,
): { patch: string | null; unavailable: boolean } {
  const saved = readRawTextArtifact(rec, "final/patch.diff");
  if (saved === null) return { patch: null, unavailable: false };
  const exact = resolveExactPatch({
    savedCopy: saved,
    meta: safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct)?.meta,
    roots: [projectRoot, recordedExecutionRoot(rec)],
  });
  return exact.ok
    ? { patch: exact.patch, unavailable: false }
    : { patch: saved, unavailable: true };
}

/** Exact patch for a mutating or digest-binding route. An unavailable exact
 * object is a typed 409 raised before any tree is touched. */
export function readExactRunPatch(rec: DaemonRunRecord, projectRoot: string | null): string | null {
  const resolved = resolveRunPatch(rec, projectRoot);
  if (resolved.unavailable) {
    throw Object.assign(new Error(EXACT_PATCH_UNAVAILABLE_MESSAGE), {
      status: 409,
      code: PATCH_EXACT_BYTES_UNAVAILABLE,
    });
  }
  return resolved.patch;
}

/** Digest a recorded operator decision must equal; null when there is no exact
 * patch to bind to (no artifact, or its exact bytes are unavailable). */
export function runPatchDigest(rec: DaemonRunRecord, projectRoot: string | null): string | null {
  const resolved = resolveRunPatch(rec, projectRoot);
  return resolved.patch !== null && !resolved.unavailable ? sha256(resolved.patch) : null;
}

/** A blob-only finding is invisible to a text scan of the patch, so the `pr`
 * publishing refusal reads the run's own disclosure for it. */
export function runPatchHasSecretLikeBinary(rec: DaemonRunRecord): boolean {
  const meta = safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct)?.meta;
  const finding = meta?.["secret_like"] as { binary_paths?: unknown } | undefined;
  return Array.isArray(finding?.binary_paths) && finding.binary_paths.length > 0;
}
