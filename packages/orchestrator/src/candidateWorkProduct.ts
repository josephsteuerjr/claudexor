import { join } from "node:path";
import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import type { ModeKind, RunOutcomeFacts } from "@claudexor/schema";
import { containsSecretLikeToken, newId, sha256 } from "@claudexor/util";
import { createRevertAnchorOrNull } from "@claudexor/workspace";
import type { CandidateRun } from "./candidateEvidence.js";

/** Publish captured Git work without accepting it or performing another mutation. */
export async function publishUnverifiedGitCandidate(input: {
  run: CandidateRun;
  store: ArtifactStore;
  paths: RunPaths;
  log: EventLog;
  taskId: string;
  mode: ModeKind;
  kind: "patch" | "new_repo";
  facts: RunOutcomeFacts;
  live: boolean;
  execRoot: string;
  preTurnSha: string | null;
  postTurnSha: string | null;
  attempts?: number;
}): Promise<void> {
  if (!input.run.diff.trim() || input.run.secretDiffRefusal) return;
  if (containsSecretLikeToken(input.run.diff))
    throw new Error("unverified patch diff contains secret-like token; refusing artifact");
  const revertAnchorId = input.live
    ? await createRevertAnchorOrNull(input.execRoot, input.preTurnSha, input.postTurnSha)
    : null;
  const applyState = input.live ? "applied_review_blocked" : "not_applied";
  input.store.writeText(join(input.paths.finalDir, "patch.diff"), input.run.diff);
  input.store.writeYaml(join(input.paths.finalDir, "work_product.yaml"), {
    id: newId("wp"),
    kind: input.kind,
    source_task_id: input.taskId,
    producer_attempt_id: input.run.attemptId,
    meta: {
      harness_id: input.run.harnessId,
      result_kind: "patch",
      mode: input.mode,
      ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
      lifecycle: input.facts.lifecycle,
      outcome_facts: input.facts,
      review_verified: false,
      patch_sha256: sha256(input.run.diff),
      adopted: input.live,
      apply_state: applyState,
      pre_turn_sha: input.live ? input.preTurnSha : null,
      post_turn_sha: input.live ? input.postTurnSha : null,
      revert_anchor_id: revertAnchorId,
      execution_root: input.live ? input.execRoot : null,
    },
  });
  input.log.emit("work_product.emitted", {
    producer_attempt_id: input.run.attemptId,
    apply_state: applyState,
  });
  input.log.emit("output.ready", { kind: "patch", path: "final/patch.diff", state: "diagnostic" });
}
