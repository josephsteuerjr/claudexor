import { loadConfig } from "@claudexor/config";
import type { QuotaRegistry } from "@claudexor/daemon";
import { StatusProjectionCache, globalConfigVersion } from "./status-projection-cache.js";
import { normalizeReadiness, type HarnessStatus } from "@claudexor/gateway";
import { probeGitCapability } from "@claudexor/workspace";
import { noProjectRepoRoot } from "@claudexor/util";
import type {
  CredentialProfile,
  CredentialProfileStatus,
  CredentialUnusableObservation,
} from "@claudexor/schema";
import { withQuotaAvailability } from "@claudexor/schema";
import {
  composeCredentialProfileEvidence,
  type VendorQuotaObservations,
} from "@claudexor/orchestrator";
import { credentialUnusableLedger } from "./run-orchestrator.js";
import { accountPoolsProjection, profileAccountProjection } from "./accounts-projection.js";
import { buildGateway, buildRegistry, checkHarnessModel } from "./registry.js";
import { delegationCapabilityFor } from "./delegation-capability.js";
import { effectiveSetupLoginCapability } from "./setup-login-capability.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

export type HarnessListInput = {
  fresh?: boolean;
  includeFakes?: boolean;
  harnessIds?: string[];
};

export async function projectHarnessStatuses(statuses: readonly HarnessStatus[]) {
  const cfg = loadConfig(NO_PROJECT_ROOT);
  const adapters = buildRegistry({ includeFakes: false });
  return Promise.all(
    statuses.map(async (status) => {
      const configured = cfg.global.harnesses[status.id]?.default_model ?? null;
      // The doctor's configured-model verdict honours the harness's own
      // absence declaration (INV-104): an advisory harness passes with the
      // note in the readiness detail instead of failing on a hint-list miss.
      const check = configured
        ? (await checkHarnessModel(status.id, configured, NO_PROJECT_ROOT, true)).check
        : null;
      return {
        ...status,
        configuredModel: configured,
        configuredModelCheck: check,
        delegation: delegationCapabilityFor(status.manifest),
        setupLogin: await effectiveSetupLoginCapability(status.id, {
          getAdapter: (id) => adapters.get(id),
        }),
        readiness: normalizeReadiness({
          checks: status.checks,
          authSources: status.authSources,
          configuredModel: configured,
          configuredModelCheck: check,
        }),
      };
    }),
  );
}

/** One server-owned Accounts response builder. The opt-in form refreshes quota
 * first and then derives next_up from that exact returned response; no client
 * can accidentally pair a newer quota card with an older routing identity.
 * Returns the listing service plus the pool-authority read
 * (`GET /v2/account-pools`) so both share one cached projection. */
export function createCredentialProfilesService(quotaRegistry: () => QuotaRegistry) {
  const projectProfiles = () => {
    const profiles = loadConfig(NO_PROJECT_ROOT).global.credential_profiles;
    return Promise.all(profiles.map((profile) => profileAccountProjection(profile, profiles)));
  };
  // The plain (non-snapshot) form is the UI's poll target: without a cache it
  // ran a doctor probe per registered profile plus a full harness sweep
  // inside harnessAccountsProjection on EVERY tick — the daemon-starving load
  // behind the 2026-08-04 "Daemon unreachable: ReadTimeout" login failure.
  // The snapshot form is the explicit refresh action, not the poll path; its
  // profile probes and doctor sweep are always fresh, while the QUOTA leg
  // rides the registry cycle, which skips a vendor inside its poll
  // rate-limit cooldown and discloses that additively
  // (quota.refresh_skipped) instead of re-hammering a 429ing endpoint.
  // A login/logout invalidates this cache immediately
  // (invalidateStatusProjections), so freshness lags at most the short TTL.
  const probeAccounts = async () => {
    const harnessIds = [...buildRegistry({ includeFakes: false }).keys()].sort();
    const [profiles, statuses] = await Promise.all([
      projectProfiles(),
      buildGateway({ includeFakes: false })
        .statusAll({ cwd: NO_PROJECT_ROOT }, harnessIds)
        .catch(() => [] as HarnessStatus[]),
    ]);
    return { profiles, statuses };
  };
  // Only native probes are cached. A refusal, recovery or expiry must be
  // visible on the next read without starting another vendor process.
  const pollCache = new StatusProjectionCache<Awaited<ReturnType<typeof probeAccounts>>>({
    versionOf: globalConfigVersion,
  });
  const buildPollResponse = async () => {
    const probed = await pollCache.read(probeAccounts);
    const quota = quotaRegistry().read();
    const unusable = credentialUnusableLedger.live();
    const evidence = { ...quota, honored: credentialUnusableLedger.honored() };
    const out = withAccountEvidence(probed.profiles, evidence, unusable);
    return {
      profiles: out,
      // Unified account model: the legacy carrier stays PRESENT and empty for
      // strict old clients; routing facts ride accountPools.
      harnessAccounts: [],
      accountPools: await accountPoolsProjection(NO_PROJECT_ROOT, quota.snapshots, {
        profiles: out,
        statuses: probed.statuses,
        quota: evidence,
        unusable,
      }),
    };
  };
  const credentialProfiles = async (input?: { snapshot?: boolean }) => {
    if (input?.snapshot === true) {
      const [probed, accountStatuses, git, fencedQuota] = await Promise.all([
        projectProfiles(),
        buildGateway({ includeFakes: false }).statusAllForAccounts({
          cwd: NO_PROJECT_ROOT,
          fresh: true,
        }),
        probeGitCapability(),
        quotaRegistry().refreshWithCursor(),
      ]);
      const statuses = accountStatuses.map((receipt) => receipt.status);
      const rawQuota = fencedQuota.response;
      const unusable = credentialUnusableLedger.live();
      const evidence = { ...rawQuota, honored: credentialUnusableLedger.honored() };
      const out = withAccountEvidence(probed, evidence, unusable);
      // The explicit refresh proved the live state — drop the stale poll
      // cache so the next ordinary poll recomputes from it (re-priming with a
      // snapshot-derived projection was explicitly declined, wave-3 decision).
      pollCache.invalidate();
      return {
        profiles: out,
        harnessAccounts: [],
        accountPools: await accountPoolsProjection(NO_PROJECT_ROOT, rawQuota.snapshots, {
          profiles: out,
          statuses,
          quota: evidence,
          unusable,
        }),
        harnesses: await projectHarnessStatuses(statuses),
        git,
        quota: withQuotaAvailability(rawQuota),
        quotaEventCursor: fencedQuota.quotaEventCursor,
      };
    }
    return buildPollResponse();
  };
  const accountPools = async () => ({
    accountPools: (await buildPollResponse()).accountPools,
  });
  return { credentialProfiles, accountPools };
}

/**
 * Replace each profile's LOCAL verification verdict with the vendor's, wherever
 * the quota poller already has one. Applied before `harnessAccounts` is built
 * so the routing identity (`next_up`) and the listed status can never disagree:
 * a revoked profile must not be advertised as who the next run routes to.
 */
function withAccountEvidence<
  T extends { profile: CredentialProfile; status: CredentialProfileStatus },
>(
  entries: T[],
  quota: VendorQuotaObservations,
  unusable: readonly CredentialUnusableObservation[],
): T[] {
  return entries.map((entry) => ({
    ...entry,
    status: composeCredentialProfileEvidence(entry.status, {
      quota,
      unusable,
      model: null,
      route: entry.profile.credential_kind === "api_key" ? "managed_api_key" : "vendor_native",
    }),
  }));
}
