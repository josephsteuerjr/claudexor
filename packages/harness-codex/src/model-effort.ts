import { effortLadders, resolveEffortEvidence } from "@claudexor/core";
import type { ModelCatalogEntry } from "@claudexor/schema";

/** Codex's typed Ultra selector owns automatic delegation in the native agent.
 * It is never a literal Responses effort (ModelInfo::resolve_reasoning_effort,
 * codex-cli 0.156.1). This projection is only for raw model calls; native runs
 * keep the selector and let the CLI implement its complete agent mode. */
export function codexModelEfforts(preferenceOrder: string[]) {
  const reasoningEfforts = preferenceOrder.filter((effort) => effort !== "ultra");
  return {
    reasoningEfforts,
    ...(reasoningEfforts.length !== preferenceOrder.length
      ? { reasoningEffortPreferenceOrder: preferenceOrder }
      : {}),
  };
}

export function codexModelEffortResolution(
  requested: string | undefined,
  model: ModelCatalogEntry,
  models: ModelCatalogEntry[],
) {
  // Re-project historical operation-local catalogs too: their verified array
  // may still contain the native selector, but remains vendor ordering evidence.
  // The account's verified per-model orders rank first; the shared preference
  // order (merged from the same raw lists) only places a word none of them list.
  const resolution = resolveEffortEvidence(
    requested,
    codexModelEfforts(model.reasoningEfforts).reasoningEfforts,
    effortLadders(
      models
        .filter((entry) => entry.reasoningEffortsVerified === true)
        .map((entry) => entry.reasoningEffortPreferenceOrder ?? entry.reasoningEfforts),
    ),
    "account_catalog",
    "reasoning.effort",
    model.reasoningEffortsVerified !== true,
  );
  if (
    requested === "ultra" &&
    (model.reasoningEffortPreferenceOrder ?? model.reasoningEfforts).includes(requested) &&
    resolution.resolution === "downward"
  ) {
    // A receipt reason on a downward result is the shared-order placement note;
    // keep it behind the session-Ultra explanation rather than overwrite it.
    resolution.reason =
      "Raw model calls do not execute Codex's Ultra automatic-delegation mode; " +
      "the preference resolves to the strongest supported generation effort" +
      (resolution.reason ? `. ${resolution.reason}` : " within the vendor order.");
  }
  return resolution;
}
