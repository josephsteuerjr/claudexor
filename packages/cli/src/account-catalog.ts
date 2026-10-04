import { credentialProfilePolicyState, type HarnessAdapter } from "@claudexor/core";
import {
  liveUnusableFor,
  profileQuotaBlock,
  profileStatusAdmits,
  resolveCredentialProfile,
  vendorVerifiedProfileStatus,
} from "@claudexor/orchestrator";
import {
  ControlProblem,
  type AccountCatalogAvailability,
  type CredentialProfile,
  type CredentialUnusableObservation,
  type GlobalConfig,
  type QuotaAbsence,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { accountObservations, displayAccountObservation } from "./account-observations.js";

export interface AccountCatalogContext {
  config: GlobalConfig;
  quota: { snapshots: readonly QuotaSnapshot[]; absences: readonly QuotaAbsence[] };
  unusable?: readonly CredentialUnusableObservation[];
}

function catalogProblem(code: string, message: string, context = {}): ControlProblem {
  return ControlProblem.parse({ code, message, retryable: false, context });
}

/** Display membership uses the durable enabled registry, never the inference pool selector. */
export function catalogProfiles(
  context: AccountCatalogContext,
  harnessId: string,
  credentialProfileId?: string,
  managedLoginOnly = false,
): CredentialProfile[] {
  const profiles = context.config.credential_profiles.filter(
    (profile) => !managedLoginOnly || profile.credential_kind === "config_dir_login",
  );
  if (credentialProfileId) {
    try {
      return [resolveCredentialProfile(profiles, credentialProfileId, harnessId)];
    } catch {
      throw Object.assign(
        new Error("The pinned catalog account is unknown, disabled, or incompatible"),
        {
          code: "model_account_unavailable",
          status: 409,
          retryable: false,
        },
      );
    }
  }
  return profiles.filter((profile) => profile.enabled && profile.harness_id === harnessId);
}

async function accountAvailability(
  context: AccountCatalogContext,
  adapter: HarnessAdapter | undefined,
  profile: CredentialProfile,
): Promise<AccountCatalogAvailability & { canReadCatalog: boolean }> {
  const row = { credentialProfileId: profile.profile_id };
  const unavailable = (problem: ControlProblem) => ({
    ...row,
    availability: "unavailable" as const,
    problem,
    canReadCatalog: false,
  });
  if (context.config.harnesses[profile.harness_id]?.enabled === false)
    return unavailable(
      catalogProblem("model_source_unavailable", "This harness is disabled in settings"),
    );
  const cardinality = credentialProfilePolicyState({
    adapter,
    registry: context.config.credential_profiles,
  });
  if (cardinality.ambiguous && profile.credential_kind !== "api_key")
    return unavailable(
      catalogProblem(
        "credential_profile_ambiguous",
        "The enabled profile set exceeds this platform's credential policy",
      ),
    );
  const dead = liveUnusableFor(context.unusable ?? [], profile.harness_id, profile.profile_id);
  if (dead)
    return unavailable(
      catalogProblem(
        dead.code === "auth_revoked" ? "auth_required" : "credential_unusable",
        "Current vendor evidence marks this credential unavailable",
        { observedAt: dead.observed_at },
      ),
    );
  const status = vendorVerifiedProfileStatus(
    (await displayAccountObservation(profile, adapter)).status,
    context.quota,
  );
  if (!profileStatusAdmits(profile, status)) {
    const revoked = status.verification_source === "vendor" && status.verification === "failed";
    const unknown = !revoked && (status.availability === "unknown" || status.stale === true);
    return {
      ...row,
      availability: unknown ? "unknown" : "unavailable",
      problem: catalogProblem(
        unknown ? "catalog_account_status_unknown" : revoked ? "auth_required" : "auth_unavailable",
        "The account has no verified current catalog credential",
        { observedAt: status.last_verified_at },
      ),
      canReadCatalog: false,
    };
  }
  const blocked = profileQuotaBlock(
    context.quota.snapshots,
    profile.harness_id,
    profile.profile_id,
    profile.credential_kind === "api_key" ? "api_key" : "local_session",
  );
  return {
    ...row,
    availability: blocked ? "unavailable" : "available",
    problem: blocked
      ? catalogProblem("subscription_window_exhausted", "The account has an active quota limit", {
          resetsAt: blocked.resets_at,
        })
      : null,
    // Quota blocks inference, not a read of the account's inventory.
    canReadCatalog: true,
  };
}

/** Each account retains its own cold display acquisition, including failure. */
export async function enumerateAccountCatalogs<T>(input: {
  context: AccountCatalogContext;
  adapter: HarnessAdapter | undefined;
  profiles: readonly CredentialProfile[];
  read(profile: CredentialProfile, canReadCatalog: boolean): Promise<T | null>;
  observationKey: string;
}): Promise<Array<AccountCatalogAvailability & { catalog: T | null }>> {
  return Promise.all(
    input.profiles.map(async (profile) => {
      const { canReadCatalog, ...facts } = await accountAvailability(
        input.context,
        input.adapter,
        profile,
      );
      try {
        const { value: catalog } = await accountObservations.read(
          input.observationKey,
          profile,
          () => input.read(profile, canReadCatalog),
        );
        return catalog === null && facts.problem === null
          ? {
              ...facts,
              availability: "unknown" as const,
              problem: catalogProblem(
                "model_catalog_unavailable",
                "This account has no catalog observation",
              ),
              catalog,
            }
          : { ...facts, catalog };
      } catch (error) {
        const provided = ControlProblem.safeParse(
          error && typeof error === "object" && "problem" in error ? error.problem : null,
        );
        const problem = provided.success
          ? provided.data
          : catalogProblem("model_catalog_unavailable", "This account's catalog could not be read");
        // An upstream outage does not prove authentication is absent or revoked.
        const refused =
          problem.code === "auth_required" || problem.code === "subscription_window_exhausted";
        return {
          ...facts,
          availability: refused
            ? ("unavailable" as const)
            : facts.availability === "unavailable"
              ? ("unavailable" as const)
              : ("unknown" as const),
          problem: ControlProblem.parse(JSON.parse(redactSecrets(JSON.stringify(problem)))),
          catalog: null,
        };
      }
    }),
  );
}
