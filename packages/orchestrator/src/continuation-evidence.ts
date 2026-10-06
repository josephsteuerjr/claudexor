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
  /** Earlier runs, oldest first; each keeps its own tool-result pairing boundary. */
  predecessors?: readonly PredecessorEvidenceSource[];
}

export type PredecessorEvidenceSource = Omit<EvidenceIndexSources, "predecessors"> & {
  retainedOutput: string;
  diffStat: string | null;
};

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
  predecessorArtifacts?: EvidenceIndexInput["artifacts"][];
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

/** Per-section verbatim budget. */
export const EVIDENCE_SECTION_BUDGET_BYTES = 8 * 1024;
/** Whole-index budget; the tool index collapses to counts past it. */
export const EVIDENCE_TOTAL_BUDGET_BYTES = 24 * 1024;
/** Tool rows kept verbatim before the index collapses to counts. */
export const EVIDENCE_TOOL_ROWS = 60;

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Truncate to at most `maxBytes` UTF-8 bytes on a safe char boundary. */
function bound(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (bytes(text) <= maxBytes) return { text, cut: false };
  const marker = "\n…[truncated]";
  const buf = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - bytes(marker)));
  for (let trim = 0; trim <= 3 && trim <= buf.length; trim += 1) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        trim === 0 ? buf : buf.subarray(0, buf.length - trim),
      );
      return { text: `${decoded}${marker}`, cut: true };
    } catch {
      /* prefix ended inside a scalar; back off */
    }
  }
  return { text: `${buf.toString("utf8")}${marker}`, cut: true };
}

const CAUSE_LINE: Record<ResumableCause, string> = {
  vendor_limit: "a usage limit on its account",
  pool_exhausted: "every account's usage limit",
  pinned_limit: "the pinned account's usage limit",
  transport: "a process death",
  context_exhausted: "context exhaustion",
  wall_clock: "the wall-clock deadline",
  cancelled: "a cancel",
  host_restart: "a host restart",
  input_required: "a request for input",
  other: "an interruption",
};

/** Pure: render the bounded evidence index for a packet carrier. */
export function buildEvidenceIndex(input: EvidenceIndexInput): EvidenceIndex {
  let summarized = false;
  const section = (text: string): string => {
    const b = bound(text.trim(), EVIDENCE_SECTION_BUDGET_BYTES);
    summarized ||= b.cut;
    return b.text;
  };
  const unresolved = input.toolCalls.filter((call) => !call.resolved);
  const parts: string[] = [
    "# Evidence index of the interrupted work",
    "",
    `The previous process stopped (${CAUSE_LINE[input.cause]}) before finishing. This index is mechanical evidence of what it was asked, told and did; it is not a summary. The workspace is as it was left.`,
    "",
    "## Original work order",
    "",
    section(input.workOrder) || "(empty)",
    "",
  ];
  if (input.steering.length > 0) {
    parts.push("## Messages sent while it ran", "");
    for (const [index, message] of input.steering.entries()) {
      const delivery =
        message.delivery === "confirmed"
          ? "delivered"
          : "delivery uncertain — reconcile against the work, do not replay blindly";
      parts.push(`### Message ${index + 1} (${delivery})`, "", section(message.text), "");
    }
  }
  parts.push("## Retained assistant output", "");
  parts.push(input.retainedOutput.trim() ? section(input.retainedOutput) : "(no output retained)");
  parts.push("", "## Tool calls", "");
  if (input.toolCalls.length === 0) {
    parts.push("(none recorded)");
  } else if (input.toolCalls.length > EVIDENCE_TOOL_ROWS) {
    summarized = true;
    parts.push(
      `${input.toolCalls.length} tool calls recorded, ${unresolved.length} without a recorded result (cut off). The last ${EVIDENCE_TOOL_ROWS} follow:`,
      "",
      ...input.toolCalls.slice(-EVIDENCE_TOOL_ROWS).map(toolRow),
    );
  } else {
    parts.push(...input.toolCalls.map(toolRow));
  }
  parts.push("", "## Changed files", "");
  parts.push(input.diffStat && input.diffStat.trim() ? section(input.diffStat) : "(no diff stat)");
  const refs = [input.artifacts, ...(input.predecessorArtifacts ?? [])]
    .flatMap((artifacts) => [
      artifacts.eventsLog && `- Event log: ${artifacts.eventsLog}`,
      artifacts.attemptDir && `- Attempt artifacts: ${artifacts.attemptDir}`,
      artifacts.patch && `- Patch so far: ${artifacts.patch}`,
    ])
    .filter((line): line is string => typeof line === "string");
  const footer = [
    "",
    "",
    "## Full evidence",
    "",
    refs.length ? section(refs.join("\n")) : "(no artifact paths available)",
    "",
    `Tool calls: ${input.toolCalls.length}; unresolved: ${unresolved.length}.`,
    "",
  ].join("\n");
  const prose = parts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  const total = bound(prose, EVIDENCE_TOTAL_BUDGET_BYTES - bytes(footer));
  summarized ||= total.cut;
  const markdown = total.text + footer;
  return {
    markdown,
    summarized,
    toolCalls: input.toolCalls.length,
    unresolvedToolCalls: unresolved.length,
    bytes: bytes(markdown),
  };
}

function toolRow(call: EvidenceToolCall): string {
  const target = call.target ? ` — ${call.target.replace(/\s+/g, " ").slice(0, 160)}` : "";
  return `- ${call.name}${target} (${call.resolved ? "completed" : "unresolved: no result recorded"})`;
}
