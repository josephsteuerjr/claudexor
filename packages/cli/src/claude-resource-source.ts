import {
  emptyResourceFacet,
  observedResourceFacet,
  type AccountResourceObservation,
  type AccountResetOffer,
  type QuotaSubject,
} from "@claudexor/schema";
import type { QuotaRefreshCycle } from "@claudexor/daemon";
import type { ClaudeOauthUsageDeps } from "./claude-oauth-usage.js";
import { readClaudeOauthOrganization } from "./claude-oauth-credential.js";
import {
  objectValue,
  parseClaudeAccountResources,
  parseClaudePrepaid,
} from "./claude-account-resources.js";
import { claudeResourceRequest } from "./claude-resource-transport.js";

/** A successful HTTP response resolves a program only with its explicit null
 * or a parsed fact. Missing/fieldless/malformed bodies are not empty inventories. */
function resolvedProgram(body: unknown, key: string, offer: AccountResetOffer | undefined) {
  const root = objectValue(body);
  if (!root || !Object.hasOwn(root, key)) return false;
  if (root[key] === null) return true;
  return (
    offer !== undefined &&
    (offer.eligible !== null ||
      offer.usable_now !== null ||
      offer.available_count !== null ||
      offer.reason !== null ||
      offer.resets_at !== null ||
      !!offer.grants?.length)
  );
}

/** Supplement the existing usage observation only for foreground cycles.
 * This remains one subject pass under its existing poll owner and rate floor. */
export async function observeClaudeAccountResources(input: {
  usage: unknown;
  profileId: string;
  configDir: string;
  accessToken: string;
  requestStartedAt: Date;
  deps: Partial<ClaudeOauthUsageDeps>;
  cycle?: QuotaRefreshCycle;
  now: () => Date;
  onRateLimited: () => void;
  readNativeVersion: () => Promise<string | null>;
}): Promise<AccountResourceObservation> {
  const {
    usage,
    profileId,
    configDir,
    accessToken,
    requestStartedAt,
    deps,
    cycle,
    now,
    onRateLimited,
    readNativeVersion,
  } = input;
  const subject: QuotaSubject = {
    harness: "claude",
    credential_route: "vendor_native",
    subject_id: profileId,
    plan_label: null,
  };
  let throttled = false;
  const observation = parseClaudeAccountResources(usage, profileId, requestStartedAt);
  const granted = observation.resets?.value?.find((offer) => offer.id === "claude_granted");
  observation.resets_resolved_ids = [];
  // The ordinary usage reader owns the grant; only the supplementary reader
  // owns refill truth, even when the usage body happens to contain both keys.
  if (resolvedProgram(usage, "cedar_ember", granted)) {
    observation.resets_resolved_ids.push("claude_granted");
    observation.resets = observedResourceFacet(
      granted ? [granted] : [],
      "claude_oauth_usage",
      requestStartedAt,
    );
  } else {
    delete observation.resets;
  }
  // Additional native reads share this serial subject pass and its floor.
  // Injected quota-only tests remain completely offline.
  if (cycle?.foreground && (!deps.fetchUsage || deps.fetchRefill)) {
    const refillAt = now();
    try {
      const refill = await (
        deps.fetchRefill ??
        (async (token) =>
          claudeResourceRequest("/api/oauth/usage?at_wall=1&skip_spend=1", token, {
            version: await readNativeVersion(),
          }))
      )(accessToken);
      const extra = parseClaudeAccountResources(refill, profileId, refillAt);
      const session = extra.resets?.value?.find((offer) => offer.id === "claude_session_refill");
      if (resolvedProgram(refill, "juniper_tide", session)) {
        observation.resets_resolved_ids.push("claude_session_refill");
        observation.resets = observedResourceFacet(
          [...(observation.resets?.value ?? []), ...(session ? [session] : [])],
          "claude_oauth_usage",
          refillAt,
        );
      }
    } catch (error) {
      const paced =
        (error as { quotaAbsenceReason?: string })?.quotaAbsenceReason === "rate_limited";
      if (paced) {
        cycle?.pacing?.noteRateLimited(
          subject,
          now().getTime(),
          (error as { retryAfterMs?: number }).retryAfterMs ?? null,
        );
        throttled = true;
        onRateLimited();
      }
      // Partial reset-program failure cannot certify the whole inventory.
      observation.resets = {
        ...(observation.resets ?? emptyResourceFacet()),
        last_attempt_at: refillAt.toISOString(),
        freshness: "stale",
        last_error: "refill_read_failed",
      };
    }
  }
  if (cycle?.foreground && (!deps.fetchUsage || deps.fetchPrepaid) && !throttled) {
    const prepaidAt = now();
    try {
      const organization = await (deps.readOrganization ?? readClaudeOauthOrganization)(configDir);
      if (!organization) throw new Error("organization_unavailable");
      const prepaid = await (
        deps.fetchPrepaid ??
        (async (token, org) =>
          claudeResourceRequest(
            `/api/oauth/organizations/${encodeURIComponent(org)}/prepaid/credits`,
            token,
            { organization: org, version: await readNativeVersion() },
          ))
      )(accessToken, organization.organizationUuid);
      observation.balances = parseClaudePrepaid(prepaid, profileId, prepaidAt).balances;
    } catch (error) {
      observation.balances = {
        ...emptyResourceFacet(),
        source: "claude_prepaid",
        last_attempt_at: prepaidAt.toISOString(),
        last_error: "balance_read_unavailable",
      };
      if ((error as { quotaAbsenceReason?: string })?.quotaAbsenceReason === "rate_limited") {
        cycle?.pacing?.noteRateLimited(
          subject,
          now().getTime(),
          (error as { retryAfterMs?: number }).retryAfterMs ?? null,
        );
        throttled = true;
        onRateLimited();
      }
    }
  }
  for (const key of ["spending", "resets"] as const)
    observation[key] ??= {
      ...emptyResourceFacet(),
      last_attempt_at: requestStartedAt.toISOString(),
      last_error: "not_reported",
    };
  return observation;
}
