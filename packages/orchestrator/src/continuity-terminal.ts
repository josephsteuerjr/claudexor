/**
 * The terminal `resumable` block (INTERFACES §2): present on every terminal
 * whose WORK is unfinished and can be continued — non-success lifecycles and
 * `succeeded` runs whose work state is `needs_input`/`incomplete`. The attempt
 * loop decides it (`InRunContinuity.finish`); this owner materializes it as
 * `final/resumable.yaml` and the payload fragment every terminal event carries,
 * so no lane re-derives the block.
 */
import { join } from "node:path";
import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import type { ResumableCause, RunResumable } from "@claudexor/schema";

export interface ContinuityTerminalFacts {
  resumable?: RunResumable;
  /** Internal snapshot used only if gates/review/arbitration later leave work unfinished. */
  resumableOnFailure?: RunResumable;
}

/** Execution roots without an isolated envelope survive this run (Agent and Ask). */
export function continuityWorkspace(
  envelope: { worktree_path: string; repo_root: string } | null,
  cwd: string,
): RunResumable["workspace"] {
  return !envelope || envelope.worktree_path === envelope.repo_root
    ? { kind: "in_place", root: cwd }
    : { kind: "none", root: null };
}

/** The first attempt that declared continuation facts speaks for the run. */
export function resumableOf(
  items: ReadonlyArray<ContinuityTerminalFacts>,
  cause?: ResumableCause,
): RunResumable | null {
  const declared = items.find((item) => item.resumable)?.resumable;
  if (declared) return declared;
  if (!cause) return null;
  const completed = items.find((item) => item.resumableOnFailure)?.resumableOnFailure;
  return completed ? { ...completed, cause } : null;
}

/** Write `final/resumable.yaml` when present and return the terminal payload fragment. */
export function resumableTerminal(
  store: ArtifactStore,
  paths: Pick<RunPaths, "finalDir">,
  items: ReadonlyArray<ContinuityTerminalFacts>,
  nonSuccess = false,
): { resumable: RunResumable } | Record<never, never> {
  const resumable = resumableOf(items, nonSuccess ? "other" : undefined);
  if (!resumable) return {};
  store.writeYaml(join(paths.finalDir, "resumable.yaml"), resumable);
  return { resumable };
}
