import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import { SHORT_ID_LENGTH } from "@claudexor/util";
import type { CatalogInputLimit, HarnessInputLimit, HarnessRunSpec } from "@claudexor/schema";

export function threadContextPointer(path: string): string {
  return `Earlier conversation context for this thread is at: ${path} — read it before answering.`;
}

export function promptWithPointers(
  prompt: string,
  ...pointers: (string | null | undefined)[]
): string {
  return [prompt, ...pointers].filter((part): part is string => Boolean(part)).join("\n\n");
}

/** Pure projection over the real path/id/prompt producers; creates no run or directory. */
export function catalogInputLimits(limits: readonly HarnessInputLimit[]): CatalogInputLimit[] {
  const paths = new ArtifactStore("/nonexistent-claudexor-project").runPaths(
    `run-${"0".repeat(SHORT_ID_LENGTH)}`,
  );
  const framed = promptWithPointers("x", threadContextPointer(join(paths.contextDir, "THREAD.md")));
  const engineOverheadMax = Array.from(framed).length - 1;
  return limits.map((limit) => ({
    ...limit,
    askPromptBudget: { shape: "ordinary_initial_attempt", engineOverheadMax },
  }));
}

/** WorkReport guidance stays in instructions, outside native turn-text capacity. */
export function applyWorkEnvelope(
  spec: HarnessRunSpec,
  workEnvelope: import("./workReportEnvelope.js").ResolvedWorkReportEnvelope,
): import("./workReportEnvelope.js").WorkReportEnvelopeMode {
  if (workEnvelope.outputSchema !== undefined) spec.output_schema = workEnvelope.outputSchema;
  const instruction = workEnvelope.mode.instruction;
  if (instruction) {
    spec.instructions =
      spec.instructions && spec.instructions.trim()
        ? `${spec.instructions}\n\n${instruction}`
        : instruction;
  }
  return workEnvelope.mode;
}
