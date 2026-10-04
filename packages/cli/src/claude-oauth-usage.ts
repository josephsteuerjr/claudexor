import { randomUUID } from "node:crypto";
import {
  readClaudeOauthCredential,
  taggedRefreshFailure,
  type ClaudeOauthCredential,
} from "./claude-oauth-credential.js";
import { loadConfig } from "@claudexor/config";
import type { QuotaRefreshCycle, QuotaRefreshResult } from "@claudexor/daemon";
import {
  canonicalProfileConfigDir,
  CLAUDE_AUTH_REFRESH_TERMINATION_UNCONFIRMED,
  claudeNativeEnv,
  claudeOauthAccessTokenIsFresh,
  claudeQuotaModelAliases,
  defaultNativeClaudeConfigDir,
  refreshClaudeNativeAuth,
} from "@claudexor/harness-claude";
import {
  QuotaSnapshot as QuotaSnapshotSchema,
  type QuotaAbsence,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { noProjectRepoRoot, sha256 } from "@claudexor/util";
import { readAccountsMigrationFile } from "./accounts-unified-migration.js";
import {
  emitQuotaDiagnostic,
  type QuotaDiagnosticSink,
  type QuotaRefreshDiagnostic,
} from "./quota-refresh-diagnostics.js";

const SOURCE = "claude_oauth_usage" as const;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const FETCH_TIMEOUT_MS = 10_000;

/** Full subscription inventory from oauth/usage, independent of passive stream
 * windows. Access material from claude-oauth-credential stays transient for one
 * request. Claude Code owns renewal and persistence; diagnostics contain only
 * expiry/presence and physical operation receipts, never credentials. */

/** A vendor rejection remembered per PRESENTED token (INV-062: the token's
 * hash, never the token; process memory only; never persisted or logged).
 * Re-presenting a proven rejection needlessly uses endpoint capacity. Usage
 * reads have returned one-hour Retry-After pauses, whose vendor-lane floor
 * also delays healthy siblings; that is not a measured global request budget.
 * So a
 * background cycle re-states the typed `auth_revoked` absence for a
 * remembered token WITHOUT an HTTP request — the same doctrine as the codex
 * source's logged-out precheck — until the token bytes change (any re-login,
 * daemon-side or external), a daemon-side credential change clears the
 * memory (`forgetClaudeOauthRejections`), an explicit foreground refresh
 * re-asks, or the safety TTL below elapses (bounds a spurious vendor 401) —
 * and then ONE remembered token is re-verified per cycle, never all at once:
 * N dead tokens expiring together must not become an N-request burst, the
 * very storm the memory exists to prevent. The memory is bounded by recent
 * rejection churn: each cycle releases the oldest expired entry whether or
 * not its token is still presented, so an entry lives at most the TTL plus
 * one cycle per older expired sibling. */
const REVOKED_TOKEN_REPROBE_MS = 6 * 60 * 60_000;
const rejectedTokens = new Map<string, number>();
/** Bumped by every forget: a cycle that started before a credential change
 * must not restore a rejection it observed with the pre-change credentials
 * (the same fence the registry's credential generation gives its own writes). */
let rejectionEpoch = 0;

/** Daemon-side credential change (login/logout/profile mutation): every
 * remembered rejection is re-verified on the next cycle. Fail-open by
 * contract — over-clearing costs at most one probe. */
export function forgetClaudeOauthRejections(): void {
  rejectedTokens.clear();
  rejectionEpoch += 1;
}

/** Release the OLDEST expired entry (age past the TTL, or a negative age
 * after a wall-clock step) so its token is re-verified this cycle; younger
 * expired siblings wait for a later cycle. */
function releaseExpiredRejection(nowMs: number): void {
  let oldest: [string, number] | null = null;
  for (const entry of rejectedTokens) {
    const age = nowMs - entry[1];
    if (age < REVOKED_TOKEN_REPROBE_MS && age >= 0) continue;
    if (oldest === null || entry[1] < oldest[1]) oldest = entry;
  }
  if (oldest !== null) rejectedTokens.delete(oldest[0]);
}

const VENDOR_REFRESH_REQUIRED_DETAIL =
  "OAuth access token freshness is unknown; Claude Code did not expose a refreshable expiry for quota reading";
const VENDOR_REFRESH_FAILED_DETAIL =
  "Claude Code's automatic OAuth refresh did not publish a fresh access token before quota reading";

/** Expiry and refresh-token PRESENCE are the only refresh metadata retained.
 * The refresh token itself never leaves the vendor credential body (INV-062). */
function needsVendorRefresh(credential: ClaudeOauthCredential, observedAt: Date): boolean {
  return (
    credential.hasRefreshToken &&
    credential.expiresAtMs !== null &&
    !claudeOauthAccessTokenIsFresh(credential.expiresAtMs, observedAt.getTime())
  );
}

export type ClaudeOauthCredentialRefresher = (
  configDir: string,
  platform: NodeJS.Platform,
  readCredential: typeof readClaudeOauthCredential,
  diagnostic?: NonNullable<Parameters<typeof refreshClaudeNativeAuth>[2]>["diagnostic"],
) => Promise<ClaudeOauthCredential | null>;

/** Keep refresh-token custody and store writes inside Claude Code. Claudexor
 * wakes the vendor's prompt-free MCP server, observes expiry metadata, then
 * re-reads the access token only after the vendor has published fresh state. */
async function refreshCredentialDefault(
  configDir: string,
  platform: NodeJS.Platform,
  readCredential: typeof readClaudeOauthCredential,
  diagnostic?: NonNullable<Parameters<typeof refreshClaudeNativeAuth>[2]>["diagnostic"],
): Promise<ClaudeOauthCredential | null> {
  const refreshed = await refreshClaudeNativeAuth(
    claudeNativeEnv(undefined, configDir),
    async () => (await readCredential(configDir, platform))?.expiresAtMs ?? null,
    { diagnostic },
  );
  if (!refreshed) throw taggedRefreshFailure(VENDOR_REFRESH_FAILED_DETAIL);
  const credential = await readCredential(configDir, platform);
  if (credential === null || !claudeOauthAccessTokenIsFresh(credential.expiresAtMs)) {
    throw taggedRefreshFailure(VENDOR_REFRESH_FAILED_DETAIL);
  }
  return credential;
}

/** Pure mapping of the oauth/usage response onto QuotaSnapshot (testable). */
export function parseClaudeOauthUsage(
  value: unknown,
  subjectId: string | null,
  planLabel: string | null,
  observedAt = new Date(),
): QuotaSnapshot | null {
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!root) return null;
  const constraints = [
    windowConstraint(root["five_hour"], "five_hour", "5 hour", 5 * 60 * 60),
    windowConstraint(root["seven_day"], "seven_day", "7 day", 7 * 24 * 60 * 60),
    ...scopedConstraints(root["limits"]),
  ].filter((item) => item !== null);
  if (constraints.length === 0) return null;
  return QuotaSnapshotSchema.parse({
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: planLabel,
      subject_id: subjectId,
    },
    constraints,
    source: SOURCE,
    observed_at: observedAt.toISOString(),
    freshness: "fresh",
  });
}

function windowConstraint(
  value: unknown,
  id: string,
  label: string,
  windowSeconds: number,
): Record<string, unknown> | null {
  const window = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!window) return null;
  const utilization = window["utilization"];
  if (typeof utilization !== "number") return null;
  return {
    id,
    label,
    used_ratio: Math.min(Math.max(utilization / 100, 0), 1),
    window_seconds: windowSeconds,
    resets_at: typeof window["resets_at"] === "string" ? window["resets_at"] : null,
    cooldown_until: null,
  };
}

/** Per-model scoped weekly limits ride as extra constraints (label carries the model). */
function scopedConstraints(value: unknown): Array<Record<string, unknown> | null> {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const limit = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    if (!limit || limit["kind"] !== "weekly_scoped") return null;
    const percent = limit["percent"];
    if (typeof percent !== "number") return null;
    const scope = limit["scope"] as Record<string, unknown> | undefined;
    const model = scope?.["model"] as Record<string, unknown> | undefined;
    const displayName =
      typeof model?.["display_name"] === "string" ? model["display_name"].trim() : "";
    const name = displayName || "scoped";
    const appliesToModels = displayName ? claudeQuotaModelAliases(displayName) : null;
    return {
      id: `weekly_scoped:${name}`,
      label: `7 day (${name})`,
      ...(appliesToModels ? { applies_to_models: appliesToModels } : {}),
      used_ratio: Math.min(Math.max(percent / 100, 0), 1),
      window_seconds: 7 * 24 * 60 * 60,
      resets_at: typeof limit["resets_at"] === "string" ? limit["resets_at"] : null,
      cooldown_until: null,
    };
  });
}

export interface ClaudeOauthUsageDeps {
  readCredential: typeof readClaudeOauthCredential;
  refreshCredential: ClaudeOauthCredentialRefresher;
  fetchUsage: (accessToken: string) => Promise<unknown>;
  now: () => Date;
  platform: NodeJS.Platform;
  diagnostic: QuotaDiagnosticSink;
}

/** Ceiling on a vendor-supplied Retry-After (7 days, aligned with the
 * pacer's floor ceiling): an absurd or overflowing header must clamp here at
 * the PARSER — an unrepresentable number reaching the schema would invalidate
 * the whole typed rate_limited observation and drop the batch, so the floor
 * would never arm at exactly the moment it matters. */
const MAX_RETRY_AFTER_HEADER_MS = 7 * 24 * 60 * 60_000;

/** RFC 9110 Retry-After → milliseconds from `now`: delta-seconds or an
 * HTTP-date, clamped to [0, MAX_RETRY_AFTER_HEADER_MS] (a non-finite or
 * oversized value clamps to the ceiling — the vendor DID ask for a long
 * pause; the observation is kept, bounded). Null only for a missing or
 * unparseable header — the floor is then unknown and pacing falls back to
 * exponential backoff. */
export function parseRetryAfterHeaderMs(
  header: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  const deltaMs = /^\d+$/.test(trimmed)
    ? Number(trimmed) * 1000
    : Number.isFinite(Date.parse(trimmed))
      ? Date.parse(trimmed) - nowMs
      : null;
  if (deltaMs === null) return null;
  if (!Number.isFinite(deltaMs)) return MAX_RETRY_AFTER_HEADER_MS;
  return Math.min(Math.max(0, Math.round(deltaMs)), MAX_RETRY_AFTER_HEADER_MS);
}

async function fetchUsageDefault(
  accessToken: string,
  status: (code: number) => void,
): Promise<unknown> {
  const res = await fetch(USAGE_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "anthropic-beta": OAUTH_BETA_HEADER,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  status(res.status);
  // A 401/403 is tagged as the vendor rejecting the presented access token.
  // The caller owns the credential-expiry context: a token known to have
  // expired while refreshable is awaiting Claude Code's vendor-owned refresh,
  // not evidence that the account itself was revoked.
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`oauth/usage responded ${res.status}`), {
      quotaAbsenceReason: "auth_revoked" as QuotaAbsence["reason"],
    });
  }
  // A 429 throttles the POLL, not the plan: typed `rate_limited` so the pacer
  // can honor the vendor's Retry-After floor (owner decision 7=A: this stays
  // pacing evidence and is never journaled as a quota cooldown). Anthropic
  // does not always send Retry-After — retryAfterMs is then null.
  if (res.status === 429) {
    throw Object.assign(new Error("oauth/usage responded 429"), {
      quotaAbsenceReason: "rate_limited" as QuotaAbsence["reason"],
      retryAfterMs: parseRetryAfterHeaderMs(res.headers.get("retry-after")),
    });
  }
  // Everything else stays an undiagnosed refresh failure.
  if (!res.ok) throw new Error(`oauth/usage responded ${res.status}`);
  return res.json();
}

function claudeOauthAbsence(
  subjectId: string | null,
  reason: QuotaAbsence["reason"],
  detail: string,
  observedAt: Date,
): QuotaAbsence {
  return {
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: subjectId,
    },
    reason,
    detail,
    observed_at: observedAt.toISOString(),
  };
}

/** One subject per logged-in config dir: the default native dir (subject null)
 * plus every enabled claude config_dir_login profile (subject = profile_id).
 * The PRIMARY claude source (release cut V11a) — it owns the claude subject
 * universe, so every candidate resolves to a snapshot OR a typed absence:
 * a null credential is not_logged_in (on macOS the keychain read cannot tell
 * a missing item from an unavailable keychain, so its detail states both; off
 * macOS a missing credential file IS the vendor's logged-out state), a store
 * read fault is the tagged reason it carries, an expired refreshable token is
 * automatically refreshed by Claude Code without inference, and a fetch
 * refusal is refresh_failed unless a known-fresh credential is explicitly rejected.
 * A remembered rejection is re-stated without re-presenting the token on
 * background cycles (see `rejectedTokens`); a foreground cycle always asks.
 * Absence is stated, never inferred. */
export async function refreshClaudeOauthUsageQuota(
  deps: Partial<ClaudeOauthUsageDeps> = {},
  cycle?: QuotaRefreshCycle,
): Promise<QuotaRefreshResult> {
  const readCredential = deps.readCredential ?? readClaudeOauthCredential;
  const refreshCredential = deps.refreshCredential ?? refreshCredentialDefault;
  const now = deps.now ?? (() => new Date());
  const platform = deps.platform ?? process.platform;
  // Rejections observed by THIS cycle count only if no credential change
  // intervened; one expired memory is released for re-verification per cycle.
  const epoch = rejectionEpoch;
  const operationId = randomUUID();
  const report = (
    profileId: string | null,
    record: Pick<QuotaRefreshDiagnostic, "stage" | "outcome"> & Partial<QuotaRefreshDiagnostic>,
  ) =>
    emitQuotaDiagnostic(deps.diagnostic, {
      ...record,
      operationId,
      source: SOURCE,
      profileId,
      at: now().toISOString(),
      foreground: cycle?.foreground === true,
      credentialEpoch: epoch,
      current: epoch === rejectionEpoch,
    });
  releaseExpiredRejection(now().getTime());
  const notLoggedInDetail =
    platform === "darwin"
      ? "no OAuth credential in the keychain item (no login, or the keychain tool is unavailable)"
      : "no vendor credential file in the config dir (not logged in)";
  // The retired null subject must not resurrect on refresh: a MIGRATED
  // harness's former default store IS its auto-registered row, which the
  // profile loop below covers — a null duplicate would re-create the retired
  // subject every cycle and double-probe one credential (mirrors
  // quotaSubjectUniverseFromConfig's use of the migration record).
  const candidates: Array<{ subjectId: string | null; configDir: string }> =
    readAccountsMigrationFile()["claude"] === undefined
      ? [{ subjectId: null, configDir: defaultNativeClaudeConfigDir() }]
      : [];
  for (const profile of loadConfig(noProjectRepoRoot()).global.credential_profiles) {
    if (profile.harness_id !== "claude" || !profile.enabled) continue;
    if (profile.credential_kind !== "config_dir_login" || !profile.isolation_locator) continue;
    try {
      candidates.push({
        subjectId: profile.profile_id,
        configDir: canonicalProfileConfigDir(profile.isolation_locator),
      });
    } catch {
      /* a mis-registered locator is a doctor problem, not a quota crash */
    }
  }
  const snapshots: QuotaSnapshot[] = [];
  const absences: QuotaAbsence[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    let credential: ClaudeOauthCredential | null;
    try {
      credential = await readCredential(candidate.configDir, platform);
    } catch (error) {
      const tagged = (error as { quotaAbsenceReason?: QuotaAbsence["reason"] })?.quotaAbsenceReason;
      report(candidate.subjectId, {
        stage: "credential_read",
        outcome: "failed",
        reason: tagged ?? "refresh_failed",
      });
      absences.push(
        claudeOauthAbsence(
          candidate.subjectId,
          tagged ?? "refresh_failed",
          error instanceof Error ? error.message : String(error),
          now(),
        ),
      );
      continue;
    }
    if (!credential) {
      report(candidate.subjectId, {
        stage: "credential_read",
        outcome: "skipped",
        reason: "credential_absent_or_unreadable",
      });
      absences.push(
        claudeOauthAbsence(candidate.subjectId, "not_logged_in", notLoggedInDetail, now()),
      );
      continue;
    }
    let beforeRequest = now();
    if (needsVendorRefresh(credential, beforeRequest)) {
      const previousExpiresAtMs = credential.expiresAtMs;
      let nativeResult: QuotaRefreshDiagnostic["native"];
      report(candidate.subjectId, {
        stage: "native_refresh",
        outcome: "started",
        previousExpiresAtMs,
        hasRefreshToken: credential.hasRefreshToken,
      });
      const originalCredentialStillValid =
        credential.expiresAtMs !== null && credential.expiresAtMs > beforeRequest.getTime();
      try {
        const refreshed = await refreshCredential(
          candidate.configDir,
          platform,
          readCredential,
          (native) => {
            nativeResult = native;
          },
        );
        if (
          refreshed === null ||
          !claudeOauthAccessTokenIsFresh(refreshed.expiresAtMs, now().getTime())
        ) {
          throw taggedRefreshFailure(VENDOR_REFRESH_FAILED_DETAIL);
        }
        credential = refreshed;
        report(candidate.subjectId, {
          stage: "native_refresh",
          outcome: "succeeded",
          reason: "fresh_expiry_observed_writer_unknown",
          previousExpiresAtMs,
          expiresAtMs: credential.expiresAtMs,
          native: nativeResult,
        });
        beforeRequest = now();
      } catch (error) {
        report(candidate.subjectId, {
          stage: "native_refresh",
          outcome: "failed",
          reason:
            (error as { code?: string })?.code === CLAUDE_AUTH_REFRESH_TERMINATION_UNCONFIRMED
              ? "termination_unconfirmed"
              : "fresh_expiry_not_observed",
          previousExpiresAtMs,
          native: nativeResult,
        });
        // The five-minute wake is proactive. If Claude Code cannot refresh yet
        // but the presented access token is still unexpired, use that proven
        // token for this bounded request rather than hiding an available quota.
        const terminationUnconfirmed =
          (error as { code?: unknown })?.code === CLAUDE_AUTH_REFRESH_TERMINATION_UNCONFIRMED;
        if (originalCredentialStillValid && !terminationUnconfirmed) {
          beforeRequest = now();
        } else {
          absences.push(
            claudeOauthAbsence(
              candidate.subjectId,
              "refresh_failed",
              error instanceof Error ? error.message : VENDOR_REFRESH_FAILED_DETAIL,
              now(),
            ),
          );
          continue;
        }
      }
    }
    const tokenKey = sha256(credential.accessToken);
    const rejectedAt = rejectedTokens.get(tokenKey);
    if (rejectedAt !== undefined && !cycle?.foreground) {
      report(candidate.subjectId, {
        stage: "poll",
        outcome: "skipped",
        reason: "presented_token_already_rejected",
      });
      // The SAME observation re-stated: its instant is the vendor's real
      // rejection time, not this cycle's clock (stable projection signature,
      // honest "revoked at" for downstream readers).
      absences.push(
        claudeOauthAbsence(
          candidate.subjectId,
          "auth_revoked",
          `oauth/usage rejected this token at ${new Date(rejectedAt).toISOString()}; not re-asked until the token changes, a login or profile change, an explicit refresh, or ${REVOKED_TOKEN_REPROBE_MS / 3_600_000} h elapse (then one remembered token is re-verified per cycle)`,
          new Date(rejectedAt),
        ),
      );
      continue;
    }
    let httpStatus: number | undefined;
    const fetchUsage =
      deps.fetchUsage ??
      ((token: string) =>
        fetchUsageDefault(token, (status) => {
          httpStatus = status;
        }));
    try {
      report(candidate.subjectId, {
        stage: "usage_http",
        outcome: "started",
        expiresAtMs: credential.expiresAtMs,
        hasRefreshToken: credential.hasRefreshToken,
      });
      const usage = await fetchUsage(credential.accessToken);
      rejectedTokens.delete(tokenKey);
      const snapshot = parseClaudeOauthUsage(
        usage,
        candidate.subjectId,
        credential.subscriptionType,
        now(),
      );
      report(candidate.subjectId, {
        stage: "usage_http",
        outcome: snapshot ? "succeeded" : "failed",
        httpStatus,
        reason: snapshot ? "windows_observed" : "no_parseable_windows",
      });
      if (snapshot) snapshots.push(snapshot);
      else
        // BACKLOG Q-a (v3.0.3 S8): an HTTP 200 whose body parses to no quota
        // windows must yield a typed absence, never silent nothing — the
        // registry needs the observation to back off instead of re-polling.
        absences.push(
          claudeOauthAbsence(
            candidate.subjectId,
            "refresh_failed",
            "oauth/usage returned HTTP 200 without parseable quota windows",
            now(),
          ),
        );
    } catch (error) {
      // The fetch path carries typed reasons for a rejected presented token
      // (auth_revoked) and a throttled poll (rate_limited, with the vendor's
      // Retry-After floor when known). A refreshable credential whose freshness
      // cannot be proven at rejection time waits for Claude Code's vendor-owned
      // refresh instead of condemning the row. Anything untagged stays an
      // undiagnosed refresh failure.
      const tagged = (error as { quotaAbsenceReason?: QuotaAbsence["reason"] })?.quotaAbsenceReason;
      const retryAfterMs = (error as { retryAfterMs?: number | null })?.retryAfterMs;
      const observedAt = now();
      report(candidate.subjectId, {
        stage: "usage_http",
        outcome: "failed",
        httpStatus,
        reason: tagged ?? "refresh_failed",
        retryAfterMs,
      });
      const rejectedWithoutFreshnessProof =
        tagged === "auth_revoked" &&
        credential.hasRefreshToken &&
        (credential.expiresAtMs === null || needsVendorRefresh(credential, observedAt));
      // Only a PROVEN rejection is remembered: an unproven one waits for the
      // vendor-owned token refresh and is re-presented once that happened.
      if (tagged === "auth_revoked" && !rejectedWithoutFreshnessProof && epoch === rejectionEpoch) {
        rejectedTokens.set(tokenKey, observedAt.getTime());
      }
      absences.push({
        ...claudeOauthAbsence(
          candidate.subjectId,
          rejectedWithoutFreshnessProof ? "refresh_failed" : (tagged ?? "refresh_failed"),
          rejectedWithoutFreshnessProof
            ? VENDOR_REFRESH_REQUIRED_DETAIL
            : error instanceof Error
              ? error.message
              : String(error),
          observedAt,
        ),
        ...(typeof retryAfterMs === "number" && retryAfterMs >= 0
          ? { retry_after_ms: Math.round(retryAfterMs) }
          : {}),
      });
      // Short-circuit on the FIRST 429: every candidate hits the same vendor
      // endpoint, so continuing the fan-out hammers the surface that just
      // said stop. The unprobed siblings get the HONEST distinct reason —
      // their own state is unknown; a sibling's 429 is never fabricated onto
      // them as rate_limited (INV-093).
      if (tagged === "rate_limited") {
        for (const skippedCandidate of candidates.slice(index + 1)) {
          report(skippedCandidate.subjectId, {
            stage: "poll",
            outcome: "skipped",
            reason: "sibling_rate_limited",
          });
          absences.push(
            claudeOauthAbsence(
              skippedCandidate.subjectId,
              "probe_skipped_rate_limited",
              "a sibling candidate's oauth/usage probe hit the vendor rate limit this cycle",
              now(),
            ),
          );
        }
        break;
      }
    }
  }
  return { snapshots, absences };
}
