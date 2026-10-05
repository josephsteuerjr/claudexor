/**
 * Explicit reviewer-panel resolution (owner-configured panels). Every entry
 * must pass the SAME gates auto-selection uses — registered real harness,
 * enabled in settings, doctor-ok on the review route, readonly-review
 * capable — plus the model truth gate (INV-104: live inventory when the
 * adapter has `models()`, else manifest `known_models`; empty manifest truth
 * refuses) and the declared effort ladder (reviewerEffort.ts). Violations throw
 * typed HarnessUnavailableError; the orchestrator turns them into review_preflight
 * failure ARTIFACTS after run-dir creation, before candidates spend money.
 *
 * The one thing the EXPLICIT gate does not decide is an absence its harness
 * cannot prove: where the adapter declared `model_inventory_absence:
 * "advisory"`, a live list or a manifest hint list that lacks the requested
 * model (or a live answer with nothing at all) forwards the explicit model to
 * the vendor unchanged rather than refusing it here. An authoritative harness
 * refuses as before, the AUTOMATIC panel always skips an unlisted family at
 * zero cost, and no list is ever substituted for another.
 */
import type {
  AuthPreference,
  AuthSourceReadiness,
  ControlReviewerPanelEntry,
  CredentialProfile,
  EffortHint,
  Intent,
  ModelInventoryAbsence,
  ProviderFamily,
} from "@claudexor/schema";
import {
  ConformanceReport,
  estimateEffectiveAuthRoute,
  knownModelIdsForRoute,
} from "@claudexor/schema";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, hasModelInventoryForRoute, validateModel } from "@claudexor/core";
import { WorkspaceManager } from "@claudexor/workspace";
import type { ReviewerSpec } from "@claudexor/review";
import { reviewerEffortVerdict } from "./reviewerEffort.js";
import { safeErrorMessage } from "./runSupport.js";

const MODEL_INVENTORY_RETRY_DELAY_MS = 250;

interface PanelHarnessSettings {
  enabled?: boolean;
  default_model?: string | null;
}

export interface ReviewerPanelDeps {
  cwd: string;
  registry: Map<string, HarnessAdapter>;
  harnessSettings: Record<string, PanelHarnessSettings | undefined>;
  authPreferenceFor: (harnessId: string) => AuthPreference;
  /** Canonical account-pool owner; explicit pins are strict, null is unpinned. */
  resolveReviewerProfile?: (input: {
    harnessId: string;
    model: string | null;
    authPreference: AuthPreference;
    credentialProfileId: string | null;
    excludedProfileIds?: ReadonlySet<string>;
  }) => Promise<CredentialProfile | null>;
  /** Disclosure sink for a knob the panel did not refuse: an effort a
   * knob-less reviewer omits (either panel) or the auto panel dropped.
   * Optional: neither outcome depends on a listener being wired. */
  onIgnoredSetting?: (detail: string) => void;
}

function credentialProfileAuthRoute(profile: CredentialProfile): "local_session" | "api_key" {
  return profile.credential_kind === "api_key" ? "api_key" : "local_session";
}

function discloseAutoSkip(deps: ReviewerPanelDeps, harnessId: string, reason: string): void {
  deps.onIgnoredSetting?.(`reviewer family '${harnessId}' skipped: ${reason}`);
}

type AutoModelInventory =
  | { status: "available"; ids: Set<string>; source: "api" | "manifest" }
  | { status: "unknown"; reason: string };

async function readAutoModelInventory(
  adapter: HarnessAdapter,
  input: Parameters<NonNullable<HarnessAdapter["models"]>>[0],
): Promise<AutoModelInventory> {
  if (typeof adapter.models !== "function")
    return { status: "unknown", reason: "inventory not enumerable" };
  try {
    const models = await adapter.models(input);
    // The adapter contract is fail-soft: [] means that the provider could not
    // establish an inventory as often as it means a genuinely empty catalog.
    // Auto selection must never turn that uncertainty into a model mismatch.
    if (models.length === 0) return { status: "unknown", reason: "inventory unavailable" };
    return { status: "available", ids: new Set(models.map((model) => model.id)), source: "api" };
  } catch (error) {
    return { status: "unknown", reason: `inventory unavailable: ${safeErrorMessage(error)}` };
  }
}

export async function resolveExplicitReviewerPanel(
  deps: ReviewerPanelDeps,
  panel: ControlReviewerPanelEntry[],
): Promise<ReviewerSpec[]> {
  const { cwd, registry, harnessSettings } = deps;
  const known = [...registry.keys()].sort().join(", ");
  const modelInventory = new Map<string, Set<string>>();
  const statusByRoute = new Map<
    string,
    {
      manifest: Awaited<ReturnType<HarnessAdapter["discover"]>> | null;
      status: "ok" | "degraded" | "unavailable";
      enabledIntents: Intent[];
      reasons: string[];
      authSources: AuthSourceReadiness[];
    }
  >();
  const specs: ReviewerSpec[] = [];
  const reviewModelHome: {
    current: { env: Record<string, string>; dispose: () => void } | null;
  } = { current: null };
  try {
    const reviewModelEnv = (): Record<string, string> => {
      reviewModelHome.current ??= new WorkspaceManager(cwd).readOnlyHomeEnv();
      return reviewModelHome.current.env;
    };
    for (const entry of panel) {
      const adapter = registry.get(entry.harness);
      if (!adapter) {
        throw new HarnessUnavailableError(
          `unknown reviewer harness '${entry.harness}' (registered: ${known}); run \`claudexor harness list --all\``,
        );
      }
      if (harnessSettings[entry.harness]?.enabled === false) {
        throw new HarnessUnavailableError(
          `reviewer harness '${entry.harness}' is disabled in settings (harnesses.${entry.harness}.enabled=false)`,
        );
      }
      const authPreference = deps.authPreferenceFor(entry.harness);
      const requestedModel = entry.model ?? harnessSettings[entry.harness]?.default_model ?? null;
      if (entry.credentialProfileId && !deps.resolveReviewerProfile) {
        throw new HarnessUnavailableError(
          `reviewer credential profile "${entry.credentialProfileId}" cannot be resolved because the account-pool owner is unavailable`,
        );
      }
      const profilePinned = Boolean(entry.credentialProfileId);
      const excludedProfileIds = new Set<string>();
      for (;;) {
        const credentialProfile = deps.resolveReviewerProfile
          ? await deps.resolveReviewerProfile({
              harnessId: entry.harness,
              model: requestedModel,
              authPreference,
              credentialProfileId: entry.credentialProfileId ?? null,
              ...(excludedProfileIds.size > 0 ? { excludedProfileIds } : {}),
            })
          : null;
        if (entry.credentialProfileId && !credentialProfile) {
          throw new HarnessUnavailableError(
            `reviewer credential profile "${entry.credentialProfileId}" could not be resolved for harness '${entry.harness}'`,
          );
        }
        const routeKey = `${entry.harness}\0${authPreference}`;
        const statusKey = credentialProfile
          ? `${routeKey}\0${credentialProfile.profile_id}`
          : routeKey;
        if (!statusByRoute.has(statusKey)) {
          let manifest: Awaited<ReturnType<HarnessAdapter["discover"]>> | null = null;
          try {
            manifest = await adapter.discover();
          } catch {
            manifest = null;
          }
          if (credentialProfile) {
            statusByRoute.set(statusKey, {
              manifest,
              status: "ok",
              enabledIntents: ["review"],
              reasons: [],
              authSources: [],
            });
          } else
            try {
              const report = await adapter.doctor({ cwd, env: reviewModelEnv(), authPreference });
              statusByRoute.set(statusKey, {
                manifest,
                status: report.status,
                enabledIntents: report.enabled_intents,
                reasons: report.reasons ?? [],
                authSources: report.auth_sources ?? [],
              });
            } catch (err) {
              statusByRoute.set(statusKey, {
                manifest,
                status: "unavailable",
                enabledIntents: [],
                reasons: [err instanceof Error ? err.message : String(err)],
                authSources: [],
              });
            }
        }
        const status = statusByRoute.get(statusKey);
        const manifest = status?.manifest;
        if (!status || !manifest) {
          throw new HarnessUnavailableError(`reviewer harness '${entry.harness}' is unavailable`);
        }
        if (manifest.kind === "fake") {
          throw new HarnessUnavailableError(
            `reviewer harness '${entry.harness}' is a fake harness and cannot be used in reviewer panels`,
          );
        }
        if (status.status !== "ok") {
          const reason = status.reasons.length > 0 ? `: ${status.reasons.join("; ")}` : "";
          throw new HarnessUnavailableError(
            `reviewer harness '${entry.harness}' is not doctor-ok${reason}`,
          );
        }
        if (
          !status.enabledIntents.includes("review") ||
          !manifest.capabilities.review ||
          !manifest.access_profiles_supported.includes("readonly")
        ) {
          throw new HarnessUnavailableError(
            `reviewer harness '${entry.harness}' cannot perform readonly review`,
          );
        }
        if (requestedModel) {
          const route = credentialProfile
            ? credentialProfileAuthRoute(credentialProfile)
            : estimateEffectiveAuthRoute(authPreference, status.authSources);
          if (
            !hasModelInventoryForRoute(adapter, manifest.capabilities.model_inventory_routes, route)
          ) {
            // The manifest list is the truth source here, judged under the
            // harness's own absence declaration (INV-104): an authoritative
            // harness refuses a miss and an empty list (validateModel phrases
            // both); an advisory harness forwards the explicit model instead.
            const check = validateModel(
              requestedModel,
              knownModelIdsForRoute(manifest.capabilities.known_models, route),
              "manifest",
              manifest.capabilities.model_inventory_absence ?? "authoritative",
            );
            if (check.status !== "ok") {
              if (!entry.credentialProfileId && credentialProfile && deps.resolveReviewerProfile) {
                excludedProfileIds.add(credentialProfile.profile_id);
                continue;
              }
              throw new HarnessUnavailableError(
                `reviewer harness '${entry.harness}' refused requested model '${requestedModel}': ${check.message}; run \`claudexor models --harness ${entry.harness}\``,
              );
            }
          } else {
            // The LIVE path asks the SAME question the run gate asks: what does
            // this inventory actually prove? An advisory producer proves
            // presence only, so a miss (and an empty answer) forwards the
            // explicit model to the vendor instead of refusing it here.
            const absence = manifest.capabilities.model_inventory_absence ?? "authoritative";
            const inventoryKey = `${entry.harness}\0${authPreference}\0${credentialProfile?.profile_id ?? "default"}`;
            if (!modelInventory.has(inventoryKey)) {
              modelInventory.set(
                inventoryKey,
                await listModelIdsWithRetry(adapter.models.bind(adapter), {
                  cwd,
                  authPreference,
                  credentialProfile,
                  env: reviewModelEnv,
                  harnessId: entry.harness,
                  requestedModel,
                  absence,
                }),
              );
            }
            const models = modelInventory.get(inventoryKey);
            const check = validateModel(requestedModel, [...(models ?? [])], "api", absence);
            if (models && check.status !== "ok") {
              if (!entry.credentialProfileId && credentialProfile && deps.resolveReviewerProfile) {
                excludedProfileIds.add(credentialProfile.profile_id);
                continue;
              }
              const available = [...models].slice(0, 80).join(", ");
              const suffix = models.size > 80 ? `, ... (${models.size} total)` : "";
              throw new HarnessUnavailableError(
                `reviewer harness '${entry.harness}' does not support requested model '${requestedModel}' on the review route (available: ${available}${suffix}); run \`claudexor models --harness ${entry.harness}\``,
              );
            }
          }
        }
        const requestedEffort = entry.effort ?? null;
        // Native effort adapters resolve after the final account/model is bound.
        const effort = adapter.effortParameter
          ? ({ kind: "kept" } as const)
          : reviewerEffortVerdict(
              entry.harness,
              requestedEffort,
              manifest.capabilities,
              requestedModel,
            );
        if (effort.kind === "unplaceable") throw new HarnessUnavailableError(effort.message);
        // No effort controls: the review still runs; the preference stays in the
        // receipt as omitted and the panel says so.
        if (effort.kind === "omitted") deps.onIgnoredSetting?.(effort.disclosure);
        specs.push({
          adapter,
          providerFamily: manifest.provider_family,
          requestedModel,
          requestedEffort,
          authPreference,
          processingPreference: entry.processingPreference,
          ...(deps.resolveReviewerProfile ? { credentialProfile, profilePinned } : {}),
        });
        break;
      }
    }
  } finally {
    reviewModelHome.current?.dispose();
  }
  return specs;
}

export interface AutoReviewerPanelOverrides {
  reviewerModels?: Partial<Record<ProviderFamily, string>>;
  reviewerEfforts?: Partial<Record<ProviderFamily, EffortHint>>;
}

/**
 * Auto reviewer-panel selection (no owner-configured panel): pick up to two
 * doctor-ok, readonly-review-capable harnesses from DISTINCT provider
 * families. Eligibility consumes a point-probe in the same scoped read-only
 * env shape the reviewers later run with, and the STRICT model truth gate
 * applies to any per-family/default model override — a doomed reviewer model
 * is refused here, never forwarded to die as an opaque native error
 * mid-review.
 */
export async function resolveAutoReviewerPanel(
  deps: ReviewerPanelDeps,
  overrides: AutoReviewerPanelOverrides = {},
): Promise<ReviewerSpec[]> {
  const { cwd, registry, harnessSettings } = deps;
  const specs: ReviewerSpec[] = [];
  const seen = new Set<string>();
  const reviewHome = new WorkspaceManager(cwd).readOnlyHomeEnv();
  try {
    familyLoop: for (const adapter of registry.values()) {
      let m: Awaited<ReturnType<HarnessAdapter["discover"]>> | null = null;
      try {
        m = await adapter.discover();
      } catch (error) {
        discloseAutoSkip(deps, adapter.id, `discovery unavailable: ${safeErrorMessage(error)}`);
        continue;
      }
      if (!m) {
        discloseAutoSkip(deps, adapter.id, "discovery returned no manifest");
        continue;
      }
      if (m.kind === "fake") {
        discloseAutoSkip(deps, adapter.id, "fake harness");
        continue;
      }
      if (seen.has(m.provider_family)) continue;
      // Per-harness settings gate reviewers before doctor/model probes: a disabled
      // harness must not spend auth/API-key readiness checks.
      if (harnessSettings[adapter.id]?.enabled === false) {
        discloseAutoSkip(deps, adapter.id, "disabled in settings");
        continue;
      }
      const authPreference = deps.authPreferenceFor(adapter.id);
      const requestedModel =
        overrides.reviewerModels?.[m.provider_family] ??
        harnessSettings[adapter.id]?.default_model ??
        null;
      let credentialProfile: CredentialProfile | null = null;
      const excludedProfileIds = new Set<string>();
      for (;;) {
        if (deps.resolveReviewerProfile) {
          try {
            credentialProfile = await deps.resolveReviewerProfile({
              harnessId: adapter.id,
              model: requestedModel,
              authPreference,
              credentialProfileId: null,
              ...(excludedProfileIds.size > 0 ? { excludedProfileIds } : {}),
            });
          } catch (error) {
            // Automatic panels disclose unavailable families by omission, while
            // keeping the reason in the existing ignored-setting stream instead
            // of inventing a second reviewer ledger.
            discloseAutoSkip(deps, adapter.id, safeErrorMessage(error));
            continue familyLoop;
          }
        }
        let report: ConformanceReport | null = null;
        if (credentialProfile) {
          report = ConformanceReport.parse({
            harness_id: adapter.id,
            status: "ok",
            enabled_intents: ["review"],
          });
        } else
          try {
            report = await adapter.doctor({ cwd, env: reviewHome.env, authPreference });
          } catch (error) {
            discloseAutoSkip(deps, adapter.id, `doctor unavailable: ${safeErrorMessage(error)}`);
            continue familyLoop;
          }
        if (report.status !== "ok") {
          discloseAutoSkip(deps, adapter.id, `doctor status '${report.status}'`);
          continue familyLoop;
        }
        if (!report.enabled_intents.includes("review")) {
          discloseAutoSkip(deps, adapter.id, "review intent unavailable");
          continue familyLoop;
        }
        if (!m.capabilities.review || !m.access_profiles_supported.includes("readonly")) {
          discloseAutoSkip(deps, adapter.id, "readonly review capability unavailable");
          continue familyLoop;
        }
        // STRICT: the auto panel skips a family whose truth source does not
        // list the model, at zero cost. It does NOT inherit the explicit panel's
        // advisory forward (INV-104): nobody asked for this family by name.
        if (requestedModel) {
          const route = credentialProfile
            ? credentialProfileAuthRoute(credentialProfile)
            : estimateEffectiveAuthRoute(authPreference, report.auth_sources);
          const inventory = hasModelInventoryForRoute(
            adapter,
            m.capabilities.model_inventory_routes,
            route,
          )
            ? await readAutoModelInventory(adapter, {
                cwd,
                env: reviewHome.env,
                authPreference,
                ...(credentialProfile ? { credentialProfile } : {}),
              })
            : (() => {
                const ids = knownModelIdsForRoute(m.capabilities.known_models, route);
                return ids.length > 0
                  ? {
                      status: "available" as const,
                      ids: new Set(ids),
                      source: "manifest" as const,
                    }
                  : {
                      status: "unknown" as const,
                      reason: "manifest model inventory unavailable",
                    };
              })();
          if (inventory.status === "unknown") {
            discloseAutoSkip(deps, adapter.id, inventory.reason);
            continue familyLoop;
          }
          // Locked: automatic selection never spawns on a guess, whatever the
          // harness declares, so absence is judged authoritative here.
          const check = validateModel(
            requestedModel,
            [...inventory.ids],
            inventory.source,
            "authoritative",
          );
          if (check.status !== "ok") {
            if (credentialProfile && deps.resolveReviewerProfile) {
              excludedProfileIds.add(credentialProfile.profile_id);
              continue;
            }
            discloseAutoSkip(
              deps,
              adapter.id,
              `requested model '${requestedModel}' is unavailable: ${check.message}`,
            );
            continue familyLoop;
          }
        }
        // Preserve native preferences through final-account resolution. A
        // knob-less reviewer keeps the requested preference in its receipt
        // (omitted, disclosed); only a word its ladder cannot place is dropped.
        let requestedEffort = overrides.reviewerEfforts?.[m.provider_family] ?? null;
        const effort = adapter.effortParameter
          ? ({ kind: "kept" } as const)
          : reviewerEffortVerdict(adapter.id, requestedEffort, m.capabilities, requestedModel);
        if (effort.kind === "omitted") deps.onIgnoredSetting?.(effort.disclosure);
        if (effort.kind === "unplaceable") {
          deps.onIgnoredSetting?.(`reviewer effort dropped: ${effort.message}`);
          requestedEffort = null;
        }
        seen.add(m.provider_family);
        specs.push({
          adapter,
          providerFamily: m.provider_family,
          requestedModel,
          requestedEffort,
          authPreference,
          ...(deps.resolveReviewerProfile ? { credentialProfile, profilePinned: false } : {}),
        });
        break;
      }
      if (specs.length >= 2) break;
    }
  } finally {
    reviewHome.dispose();
  }
  return specs;
}

/** One retry with a short delay: transient inventory hiccups (cold auth,
 * slow first call) must not fail a panel that would succeed a moment later —
 * but a persistently empty/erroring inventory still refuses loudly, UNLESS the
 * producer declared its absences advisory: an empty answer from such a source
 * proves nothing, so it is returned as the empty set and the caller's shared
 * decision forwards the explicit model to the vendor (a second probe would ask
 * the same source the same unanswerable question). A thrown call is still a
 * failure, not an answer, and still refuses. */
async function listModelIdsWithRetry(
  listModels: NonNullable<HarnessAdapter["models"]>,
  input: {
    cwd: string;
    authPreference: AuthPreference;
    credentialProfile?: CredentialProfile | null;
    env: () => Record<string, string>;
    harnessId: string;
    requestedModel: string;
    absence: ModelInventoryAbsence;
  },
): Promise<Set<string>> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const models = await listModels({
        cwd: input.cwd,
        env: input.env(),
        authPreference: input.authPreference,
        ...(input.credentialProfile ? { credentialProfile: input.credentialProfile } : {}),
      });
      if (models.length === 0) {
        if (input.absence === "advisory") return new Set();
        throw new Error("model inventory was empty");
      }
      return new Set(models.map((m) => m.id));
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, MODEL_INVENTORY_RETRY_DELAY_MS));
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
  throw new HarnessUnavailableError(
    `reviewer harness '${input.harnessId}' could not verify requested model '${input.requestedModel}' because its model inventory call failed after retry: ${detail}; run \`claudexor models --harness ${input.harnessId}\``,
  );
}
