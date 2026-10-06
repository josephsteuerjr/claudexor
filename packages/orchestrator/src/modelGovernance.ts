/**
 * STRICT run-preflight model gate (INV-104): every route that resolved an
 * explicit model (per-run map or per-harness settings default) must pass its
 * harness's model truth source — the live `models()` inventory when the
 * adapter has one, else the manifest `known_models` list. A violation throws
 * a typed error BEFORE any vendor CLI spawns; the orchestrator surfaces it
 * through the routing-failure path, so failure.yaml names harness, model, and
 * truth source.
 *
 * Two rules keep the gate honest about WHICH account answered:
 * - The inventory is asked of the account the run will actually use. A
 *   profile-pinned route derives its auth route from that profile's credential
 *   kind, and the query carries the profile's own state HOME, so model truth
 *   can never come from the default credential store.
 * - Nothing about the spawned spec is rewritten to make the two agree. A
 *   profile-less `auto` run is enumerated with the same `auto` preference the
 *   adapter will resolve, so preflight and spawn share one resolution instead
 *   of the gate freezing a route the adapter would then be unable to disclose.
 *
 * A fallback model is checked by the authoritative per-spawn gate only after
 * its own quota/profile preflight; checking it against the primary profile
 * here would reject a valid cross-profile fallback.
 *
 * What a list may refuse with is the HARNESS's declaration: where the adapter
 * declared `model_inventory_absence: "advisory"`, its live inventory and its
 * manifest hints alike prove presence but not absence, so an unlisted explicit
 * model is forwarded to the vendor unchanged and disclosed once by the
 * per-spawn gate. An authoritative harness (the declaration a silent manifest
 * gets) refuses as before, and no gate ever swaps one list for another to
 * admit a model.
 */
import { billingKnowledgeForAuthRoute } from "@claudexor/budget";
import type { AuthVerification, EffortResolution, PaidFallback } from "@claudexor/schema";
import type { HarnessAdapter } from "@claudexor/core";
import {
  HarnessUnavailableError,
  effortResolutionEvent,
  resolveEffortEvidence,
  validateModel,
  hasModelInventoryForRoute,
  prepareHarnessProcessing,
  admitPreparedProcessing,
  observeCredentialExecution,
} from "@claudexor/core";
import {
  knownModelIdsForRoute,
  type CredentialProfile,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessRunSpec,
  type KnownModelEntry,
  type ModelInventoryAbsence,
} from "@claudexor/schema";

export interface ModelGovernedRoute {
  adapter: HarnessAdapter;
  /** Manifest model truth source (used when the adapter has no live models()). */
  knownModels: readonly KnownModelEntry[];
  /** The adapter's declared live-inventory contract, read from its manifest:
   * WHICH credential routes its `models()` producer answers for, and WHAT its
   * answer proves about a model it does not list (`model_inventory_absence`;
   * omitted = `authoritative` = today's refusal). Both halves travel together
   * so a caller cannot supply one and silently lose the other. */
  modelInventory?: Readonly<
    Pick<HarnessCapabilities, "model_inventory_routes" | "model_inventory_absence">
  >;
  /** Pre-spawn credential-route estimate: route-annotated manifest models are
   * filtered by it, and stay EXCLUDED when it is null (fail-closed — a
   * route-scoped model never passes the gate on an undecidable route). */
  authRouteEstimate: "local_session" | "api_key" | null;
  /** Effective account after profile preflight/rotation. Model truth must come
   * from this same identity, never the default credential store. */
  quotaAdmission: { profile: CredentialProfile | null };
  billingVerificationForProfile?: (profile: CredentialProfile) => Promise<AuthVerification>;
  paidFallback?: PaidFallback;
  settings: { defaultModel: string | null; fallbackModel: string | null } | null;
}

type ModelCandidate = { role: string; model: string };
type ModelTruth = {
  list: readonly string[];
  source: "api" | "manifest";
  route: "local_session" | "api_key" | null;
  /** The harness's own declaration (INV-104), honoured for the live list and
   * the manifest hints alike; no list is ever substituted to admit a model. */
  absence: ModelInventoryAbsence;
};

/** A pinned profile decides the route by its credential kind; without one the
 * pre-spawn estimate stands (and stays fail-closed when undecidable). */
function authRouteForProfile(
  profile: CredentialProfile | null,
  estimate: ModelGovernedRoute["authRouteEstimate"],
): ModelGovernedRoute["authRouteEstimate"] {
  if (!profile) return estimate;
  return profile.credential_kind === "api_key" ? "api_key" : "local_session";
}

async function modelTruthForRoute(
  routed: ModelGovernedRoute,
  query: {
    cwd: string;
    env?: HarnessRunSpec["env"];
    authPreference?: HarnessRunSpec["auth_preference"];
    profile: CredentialProfile | null;
  },
): Promise<ModelTruth> {
  const route = authRouteForProfile(query.profile, routed.authRouteEstimate);
  if (
    hasModelInventoryForRoute(routed.adapter, routed.modelInventory?.model_inventory_routes, route)
  ) {
    const inventory = await routed.adapter.models({
      cwd: query.cwd,
      ...(query.env ? { env: query.env } : {}),
      ...(query.authPreference ? { authPreference: query.authPreference } : {}),
      ...(query.profile ? { credentialProfile: query.profile } : {}),
    });
    return {
      list: inventory.map((model) => model.id),
      source: "api",
      route,
      absence: routed.modelInventory?.model_inventory_absence ?? "authoritative",
    };
  }
  // The manifest hint list is judged under the SAME declaration as the live
  // answer: it is one day's memory of the vendor menu that producer reads,
  // so it can refuse no more than the producer can (owner decision 2026-09-24).
  return {
    list: knownModelIdsForRoute(routed.knownModels, route),
    source: "manifest",
    route,
    absence: routed.modelInventory?.model_inventory_absence ?? "authoritative",
  };
}

/** Throws on a refused candidate; returns the notes of the candidates a truth
 * source admitted WITHOUT being able to verify them, so the caller that can
 * disclose does it once. */
function assertModelsAllowed(
  routed: ModelGovernedRoute,
  candidates: readonly ModelCandidate[],
  truth: ModelTruth,
  profile: CredentialProfile | null,
): string[] {
  const unverified: string[] = [];
  for (const { role, model } of candidates) {
    const check = validateModel(model, truth.list, truth.source, truth.absence);
    if (check.status === "ok") {
      if (check.unverified && check.message) unverified.push(check.message);
      continue;
    }
    // A pinned profile OWNS this inventory: sending the operator to the
    // profile-less `claudexor models` would print a different account's list.
    // Observations only — which account supplied which list — never a cause
    // guess ("re-authenticate", "plan", "entitlement") the gate cannot know.
    const remedy = profile
      ? `the selected credential profile '${profile.profile_id}' supplied this ${truth.source === "api" ? "live inventory" : "manifest list"} (${truth.list.length} models); inspect that profile's own vendor model list`
      : `run \`claudexor models --harness ${routed.adapter.id}\``;
    throw new HarnessUnavailableError(
      `harness '${routed.adapter.id}' refused ${role} '${model}' (truth source: ${truth.source}${truth.source === "manifest" ? `, route: ${truth.route ?? "undecided"}` : ""}): ${check.message}; ` +
        remedy,
    );
  }
  return unverified;
}

/** True when the spawn's own model truth LISTS `model` as an id (never an
 * unverifiable forward): an attested model is pinned on a continued session
 * only then, so an observed display label is never sent as a model id. */
export async function routeListsModel(
  routed: ModelGovernedRoute,
  spec: HarnessRunSpec,
  model: string,
): Promise<boolean> {
  try {
    const truth = await modelTruthForRoute(routed, {
      cwd: spec.cwd,
      env: spec.env,
      ...(spec.auth_preference ? { authPreference: spec.auth_preference } : {}),
      profile: spec.credential_profile ?? null,
    });
    return truth.list.includes(model.trim());
  } catch {
    return false;
  }
}

export async function assertRouteModelsAllowed(
  routes: readonly ModelGovernedRoute[],
  models: Record<string, string> | undefined,
  cwd: string,
  /** The mutable state HOME the eventual spawn will receive for this harness,
   * so an account-scoped inventory is read from that same home. */
  routeStateEnvFor?: (harnessId: string) => Record<string, string> | undefined,
): Promise<void> {
  const checked = new Set<string>();
  for (const routed of routes) {
    const id = routed.adapter.id;
    if (checked.has(id)) continue;
    checked.add(id);
    const resolved = models?.[id] ?? routed.settings?.defaultModel ?? null;
    if (!resolved) continue;
    const profile = routed.quotaAdmission.profile;
    const routeStateEnv = routeStateEnvFor?.(id);
    const truth = await modelTruthForRoute(routed, {
      cwd,
      ...(routeStateEnv ? { env: routeStateEnv } : {}),
      profile,
    });
    assertModelsAllowed(routed, [{ role: "model", model: resolved }], truth, profile);
  }
}

/** Refresh account evidence and admit one send without replacing captured Processing. */
export async function admitCurrentProfileDispatch(
  routed: Pick<ModelGovernedRoute, "billingVerificationForProfile" | "paidFallback">,
  spec: HarnessRunSpec,
): Promise<void> {
  if (spec.credential_profile && routed.billingVerificationForProfile) {
    // The dispatched row can differ from admission after rotation/model fallback.
    // Default-store readiness and the original row's entitlement never follow it.
    spec.extra["routeBillingKnowledge"] = billingKnowledgeForAuthRoute({
      route:
        spec.credential_profile.credential_kind === "api_key" ? "managed_api_key" : "vendor_native",
      verification: await routed.billingVerificationForProfile(spec.credential_profile),
    });
  }
  spec.extra["paidFallback"] = routed.paidFallback;
  await admitPreparedProcessing(spec);
  const markStarted = spec.extra["markPhysicalDispatchStarted"];
  if (typeof markStarted === "function") (markStarted as () => void)();
}

/**
 * Authoritative per-spawn model gate. Admission validates the initially routed
 * account early; this guard rebinds the same strict truth contract to the
 * profile, auth preference, cwd, and mutable state HOME the vendor process will
 * actually receive. Every routed spawn funnels through this generator, so a
 * quota rotation or fallback-model preflight cannot reuse another account's
 * inventory. The spec is passed to the adapter byte-identical: the gate reads
 * the run's identity, it never rewrites it.
 */
export async function* runModelGovernedRoute(
  routed: ModelGovernedRoute,
  spec: HarnessRunSpec,
): AsyncIterable<HarnessEvent> {
  let nativeModel: string | null = null;
  let preparedEffort: EffortResolution | undefined;
  if (spec.processing_preference || routed.adapter.prepareProcessing) {
    const prepared = await prepareHarnessProcessing(routed.adapter, {
      preference: spec.processing_preference,
      model: spec.model_hint,
      effort: spec.effort_hint,
      credentialProfile: spec.credential_profile,
      cwd: spec.cwd,
      env: spec.env,
      authPreference: spec.auth_preference,
      allowPaid: spec.processing_allow_paid,
    });
    nativeModel = prepared.model;
    preparedEffort = prepared.effort;
    spec = { ...spec, processing: prepared.receipt, processing_cost_basis: prepared.costBasis };
  }
  const model = spec.model_hint?.trim();
  const unverified: string[] = [];
  if (model) {
    const profile = spec.credential_profile ?? null;
    const truth = await modelTruthForRoute(routed, {
      cwd: spec.cwd,
      env: spec.env,
      authPreference: spec.auth_preference,
      profile,
    });
    unverified.push(...assertModelsAllowed(routed, [{ role: "model", model }], truth, profile));
    if (nativeModel && nativeModel !== model) {
      unverified.push(
        ...assertModelsAllowed(
          routed,
          [{ role: "native processing model", model: nativeModel }],
          truth,
          profile,
        ),
      );
    }
  }
  await admitCurrentProfileDispatch(routed, spec);
  if (spec.processing?.reason === "processing_control_unavailable") {
    yield {
      type: "status",
      ts: new Date().toISOString(),
      session_id: spec.session_id,
      processing: spec.processing,
      text: "Processing preference is unavailable; using ordinary native execution.",
    };
  }
  // A model this gate could not verify is DISCLOSED once, here, instead of
  // refused: the run log and the receipt say the vendor, not the gate, decided.
  // Preflight stays silent so one spawn speaks once.
  if (unverified.length > 0) {
    yield {
      type: "status",
      ts: new Date().toISOString(),
      session_id: spec.session_id,
      text: unverified.join("; "),
    };
  }
  // ONE effort receipt per spawn. A model-id carrier (Cursor, Antigravity)
  // produced it in the same preparation that chose `processing.submittedNative`,
  // so the id sent, the level and this disclosure cannot disagree; a route with
  // no effort carrier at all records the preference as omitted here; a flag
  // adapter (Claude, Codex, ACP) emits its own receipt at its final route.
  if (preparedEffort) yield effortResolutionEvent(spec.session_id, preparedEffort, spec);
  else if (!routed.adapter.effortParameter) {
    yield effortResolutionEvent(
      spec.session_id,
      resolveEffortEvidence(spec.effort_hint, [], [], "adapter", null),
    );
  }
  yield* observeCredentialExecution(routed.adapter.id, spec, routed.adapter.run(spec));
}
