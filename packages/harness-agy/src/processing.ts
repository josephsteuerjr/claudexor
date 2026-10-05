import {
  selectEffortVariant,
  type HarnessModelSpec,
  type HarnessProcessingSpec,
  type PreparedHarnessProcessing,
} from "@claudexor/core";
import type {
  HarnessModel,
  HarnessRunSpec,
  ProcessingCostBasis,
  ProcessingReceipt,
} from "@claudexor/schema";

export type AgyModelLister = (spec: HarnessModelSpec) => Promise<HarnessModel[]>;

/**
 * ONE prepared result for an Antigravity route. agy has no processing tiers
 * and no effort flag: the level is a token of the model id
 * (`gemini-3.8-flash-high`), so an effort preference selects the listed
 * sibling of the requested model's family — from the pinned account's live
 * `agy models` answer ONLY. No pinned account, or a list that could not be
 * read, means no rewrite: the static hint list (`AGY_KNOWN_MODELS`) is one
 * day's memory of a menu and never authorizes an id this account may not have.
 * `model` == `receipt.submittedNative` == the `--model` argument; `effort` is
 * the receipt of the level choice (`parameter: --model`). Without an effort
 * (or without a model) no vendor process is spawned here.
 */
export async function prepareAgyProcessing(
  spec: HarnessProcessingSpec,
  listModels: AgyModelLister,
): Promise<PreparedHarnessProcessing> {
  const selecting = Boolean(spec.effort && spec.model);
  const catalog =
    selecting && spec.credentialProfile ? (await listModels(spec)).map((model) => model.id) : [];
  const unavailable = spec.credentialProfile
    ? "the pinned account's `agy models` list could not be read"
    : "agy routes only through named accounts and no account is pinned, so there is no account model list";
  const level = selectEffortVariant(spec.effort, spec.model, catalog, unavailable);
  const receipt: ProcessingReceipt = {
    requested: spec.preference ?? null,
    submitted: null,
    submittedNative: level.model,
    observed: "unknown",
    observedNative: [],
    // agy offers no fast/standard service tiers; a preference stays unavailable.
    reason: spec.preference ? "processing_control_unavailable" : null,
    source: "agy_account_model_inventory",
  };
  const costBasis: ProcessingCostBasis = {
    nativeMode: null,
    kind: "unknown",
    source: "agy_cli_has_no_tier_billing_receipt",
  };
  return { model: level.model, receipt, costBasis, effort: level.effort };
}

/**
 * The run reads the final id from the prepared receipt the engine attached;
 * a direct run that only carries an effort prepares itself the same way, so
 * `--model` never bypasses the one preparation.
 */
export async function applyAgyRunProcessing(
  spec: HarnessRunSpec,
  listModels: AgyModelLister,
): Promise<{ spec: HarnessRunSpec; nativeModel: string | null }> {
  if (spec.processing || !spec.effort_hint || !spec.model_hint)
    return { spec, nativeModel: spec.processing?.submittedNative ?? spec.model_hint ?? null };
  const prepared = await prepareAgyProcessing(
    {
      preference: spec.processing_preference,
      model: spec.model_hint,
      effort: spec.effort_hint,
      cwd: spec.cwd,
      env: spec.env,
      credentialProfile: spec.credential_profile,
      authPreference: spec.auth_preference,
      allowPaid: spec.processing_allow_paid,
    },
    listModels,
  );
  return {
    spec: { ...spec, processing: prepared.receipt, processing_cost_basis: prepared.costBasis },
    nativeModel: prepared.model,
  };
}
