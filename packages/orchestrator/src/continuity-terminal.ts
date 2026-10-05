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
import type { RunResumable } from "@claudexor/schema";

/** The first attempt that declared continuation facts speaks for the run. */
export function resumableOf(
  items: ReadonlyArray<{ resumable?: RunResumable }>,
): RunResumable | null {
  return items.find((item) => item.resumable)?.resumable ?? null;
}

/** Write `final/resumable.yaml` when present and return the terminal payload fragment. */
export function resumableTerminal(
  store: ArtifactStore,
  paths: Pick<RunPaths, "finalDir">,
  items: ReadonlyArray<{ resumable?: RunResumable }>,
): { resumable: RunResumable } | Record<never, never> {
  const resumable = resumableOf(items);
  if (!resumable) return {};
  store.writeYaml(join(paths.finalDir, "resumable.yaml"), resumable);
  return { resumable };
}
