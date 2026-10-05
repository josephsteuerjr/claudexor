/**
 * Evidence-index packet builder — PURE (A10).
 *
 * When no native carrier exists (the vendor refused the moved session, the
 * adapter cannot move, the mind asked for a re-brief), the successor is a
 * FRESH vendor session re-grounded by an EVIDENCE INDEX: the original work
 * order, admitted steering (live messages) with their delivery status, the
 * retained assistant output, a tool-call index (name, completed / unresolved),
 * the diff stat and absolute paths to the predecessor's event log and attempt
 * artifacts readable from the new environment. Bounded inline with honest
 * truncation (`summarized` is true also when a single section was cut). No
 * second summarizer, no recap model call.
 *
 * This is NOT the thread continuation packet (`continuity.ts`
 * `buildContinuation`, INV-137): thread turns and the D-16d context-exhaustion
 * continuation keep that packet; the evidence index serves in-run packet hops
 * and `continueFrom`.
 */
import type { ResumableCause } from "@claudexor/schema";

/** Admitted steering message of the predecessor (POST /v2/runs/:id/messages). */
export interface EvidenceSteering {
  text: string;
  /** confirmed: the vendor echoed it into its history; uncertain: it may not have been delivered. */
  delivery: "confirmed" | "uncertain";
}

/** Where the I/O collector reads the predecessor's evidence. */
export interface EvidenceIndexSources {
  runDir: string;
  attemptId: string;
  workOrder: string;
  steering: EvidenceSteering[];
}

export interface EvidenceToolCall {
  name: string;
  target: string | null;
  /** False when the call never saw its result (cut off). */
  resolved: boolean;
}

/** Fully-resolved inputs of the pure builder (the collector reads them from the run dir). */
export interface EvidenceIndexInput {
  cause: ResumableCause;
  workOrder: string;
  steering: EvidenceSteering[];
  /** The retained assistant output (`final/retained-output.md` or the attempt's answer), "" when none. */
  retainedOutput: string;
  toolCalls: EvidenceToolCall[];
  /** `git diff --stat`-style file list of the predecessor's tree, null when unknown. */
  diffStat: string | null;
  /** Absolute paths readable from the new environment; null when absent. */
  artifacts: { eventsLog: string | null; attemptDir: string | null; patch: string | null };
}

export interface EvidenceIndex {
  /** The packet body delivered to the successor (bounded). */
  markdown: string;
  /** True when any section was truncated or collapsed. */
  summarized: boolean;
  toolCalls: number;
  unresolvedToolCalls: number;
  bytes: number;
}

/** Pure: render the bounded evidence index for a packet carrier. */
export function buildEvidenceIndex(_input: EvidenceIndexInput): EvidenceIndex {
  throw new Error("buildEvidenceIndex is not wired yet (interfaces freeze)");
}
