/**
 * The opt-in parts of the GC receipt, owned in one place: which disclosures a
 * lockstep CLI requests from `POST /v2/maintenance/gc`, and how `claudexor gc`
 * renders them. A skewed daemon gets neither flag, so both receipt fields stay
 * absent and an older strict schema never sees an unknown key (W3.6).
 */
import type { ControlGcReceipt } from "@claudexor/schema";

/** Request flags sent only to a daemon of the same engine version. */
export const GC_LOCKSTEP_REPORTS = { data_root_report: true, trash_purge_report: true } as const;

export function gcReceiptNotes(receipt: ControlGcReceipt, ownedRoot: string): string[] {
  const notes: string[] = [];
  // Advisory disclosure of foreign top-level data-root entries (never
  // deleted; absent on old daemons or a failed scan — errors carry the why).
  const foreign = receipt.data_root_unrecognized;
  if (foreign && foreign.length > 0) {
    const shown = foreign.slice(0, 10).join(", ");
    const ellipsis = foreign.length > 10 ? `, … showing 10 of ${foreign.length}` : "";
    notes.push(
      `note: ${foreign.length} non-engine entr${foreign.length === 1 ? "y" : "ies"} in ${ownedRoot}: ${shown}${ellipsis}`,
    );
  }
  // Trashed threads past their restore window, purged by this pass (or that
  // a dry run would purge). A busy or failed purge is listed under errors.
  const purged = receipt.purged_threads;
  if (purged && purged.length > 0) {
    const verb = receipt.dry_run ? "would purge" : "purged";
    notes.push(`${verb} ${purged.length} expired trash thread(s): ${purged.join(", ")}`);
  }
  // Purges whose directory cleanup failed earlier, finished by this pass.
  const leftovers = receipt.purge_leftovers;
  if (leftovers && leftovers.length > 0) {
    const verb = receipt.dry_run ? "would finish" : "finished";
    notes.push(
      `${verb} ${leftovers.length} purge(s) whose cleanup failed earlier: ${leftovers.join(", ")}`,
    );
  }
  return notes;
}
