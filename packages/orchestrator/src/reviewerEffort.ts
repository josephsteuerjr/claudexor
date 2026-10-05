/**
 * The reviewer effort gate, for adapters WITHOUT a native effort knob of their
 * own. (An adapter that declares `effortParameter` resolves the preference at
 * its final route — the account and model that actually run — and is never
 * judged here.) ONE owner for both panel paths, split out of reviewerPanel.ts.
 *
 * The wire type is an open slug, not an enum — a level only means something per
 * (harness, model) — so the manifest is the only place a reviewer effort can be
 * judged before the panel spends money. Three outcomes:
 *
 * - `kept`: nothing was requested, or the reviewer's ladder can place the word
 *   (its own vendor order first; the shared preference order only for a word
 *   that ladder does not list). The preference travels on unchanged.
 * - `omitted`: the harness declares NO effort controls, so there is nothing to
 *   place the word on. The preference is NOT a reason to lose the review: it
 *   stays in the reviewer's receipt, no native effort is submitted, and the
 *   panel discloses that (owner decision 2026-10-05; this used to refuse the
 *   whole explicit panel and to null the auto panel's request).
 * - `unplaceable`: the harness HAS a ladder and neither order places the word (a
 *   typo). Unchanged: an explicit panel refuses, the auto panel drops and
 *   discloses — without this a reviewer effort dies silently while the review
 *   artifact still records it as requested.
 */
import type { EffortHint, ModelEffortCapability } from "@claudexor/schema";
import { EFFORT_PREFERENCE_ORDER, effortLevelsForModel } from "@claudexor/schema";
import { effortLadders, resolveEffort } from "@claudexor/core";

export type ReviewerEffortVerdict =
  | { kind: "kept" }
  | { kind: "omitted"; disclosure: string }
  | { kind: "unplaceable"; message: string };

export function reviewerEffortVerdict(
  harnessId: string,
  requestedEffort: EffortHint | null,
  capabilities: {
    effort_levels: readonly EffortHint[];
    model_effort_levels: Record<string, ModelEffortCapability>;
  },
  model: string | null,
): ReviewerEffortVerdict {
  if (!requestedEffort) return { kind: "kept" };
  // Judge against the ladder of the model that will actually review: the
  // model's own advertised list when the entry resolves one and the manifest
  // recorded it, else the harness-wide merged ladder — which is then the only
  // honest set, and the refusal says so.
  const advertised = effortLevelsForModel(capabilities, model);
  if (advertised.length === 0) {
    const outside = EFFORT_PREFERENCE_ORDER.includes(requestedEffort)
      ? ""
      : `; '${requestedEffort}' is outside the shared preference order (${EFFORT_PREFERENCE_ORDER.join(" < ")})`;
    return {
      kind: "omitted",
      disclosure:
        `reviewer effort omitted: reviewer harness '${harnessId}' declares no effort controls; ` +
        `the preference '${requestedEffort}' stays in the receipt and no native effort is submitted${outside}`,
    };
  }
  const ladders = effortLadders([
    capabilities.effort_levels,
    ...Object.values(capabilities.model_effort_levels).map((entry) => entry.levels),
  ]);
  if (resolveEffort(requestedEffort, advertised, ladders).status === "ok") return { kind: "kept" };
  const perModel =
    model !== null && (capabilities.model_effort_levels[model]?.levels.length ?? 0) > 0;
  const supported = advertised.join(", ");
  const suffix = perModel
    ? ` (model '${model}' advertises: ${supported})`
    : ` (harness-wide advertised ladder — no per-model ladder recorded${model ? ` for '${model}'` : ""}: ${supported})`;
  return {
    kind: "unplaceable",
    message: `reviewer harness '${harnessId}' does not support requested effort '${requestedEffort}'${suffix}`,
  };
}
