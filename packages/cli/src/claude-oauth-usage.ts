import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
  type QuotaSubject,
} from "@claudexor/schema";
import { noProjectRepoRoot, sha256 } from "@claudexor/util";
import { fetchClaudeOauthUsage } from "./claude-oauth-fetch.js";
import { readAccountsMigrationFile } from "./accounts-unified-migration.js";

const SOURCE = "claude_oauth_usage" as const;

/**
 * The PRIMARY subscription-quota source (W5.3, live-proven 2026-07-17):
 * `GET api.anthropic.com/api/oauth/usage` with a profile's OAuth access token
 * returns proactive five_hour/seven_day utilization — the stream's rate-limit
 * signals arrive only reactively, AFTER a limit bites.
 *
 * Security (INV-062 class): the access token is read from the profile's OWN
 * vendor store — the keychain item on macOS, the vendor's
 * `<configDir>/.credentials.json` (documented 0600 file store) elsewhere —
 * held transiently for one serial refresh cycle, and never persisted,
 * logged, or included in errors. Before probing a known-expired or near-expiry
 * refreshable credential, Claudexor wakes Claude Code's prompt-free MCP server
 * and lets the vendor refresh its own store; a known-fresh 401 remains the
 * vendor's explicit rejection evidence.
 */

/** Vendor formula, live-verified: `Claude Code-credentials-<sha256(configDir)[:8]>`. */
export function claudeOauthKeychainItem(configDir: string): string {
  return `Claude Code-credentials-${sha256(configDir).replace("sha256:", "").slice(0, 8)}`;
}

export interface ClaudeOauthCredential {
  accessToken: string;
  subscriptionType: string | null;
  expiresAtMs: number | null;
  hasRefreshToken: boolean;
}

const execFileAsync = promisify(execFile);

/** Read the profile's OAuth credential from the vendor's own store: the
 * profile-keyed keychain item on macOS (`security`), or the vendor's
 * `<configDir>/.credentials.json` everywhere else — Linux has no keychain. */
export async function readClaudeOauthCredential(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ClaudeOauthCredential | null> {
  if (platform !== "darwin") return readClaudeOauthCredentialFile(configDir);
  try {
    const { stdout } = await execFileAsync(
      "security",
      [
        "find-generic-password",
        "-s",
        claudeOauthKeychainItem(configDir),
        "-a",
        userInfo().username,
        "-w",
      ],
      { timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    return parseClaudeOauthCredential(stdout);
  } catch {
    return null; // no item / locked keychain — honest absence
  }
}

/** The non-macOS vendor store (`.credentials.json`, documented mode 0600).
 * A missing file is the honest logged-out null; a present-but-unreadable or
 * unparseable file throws a reason-tagged error carrying only the error
 * class — never file bytes or a token (INV-062). */
async function readClaudeOauthCredentialFile(
  configDir: string,
): Promise<ClaudeOauthCredential | null> {
  let raw: string;
  try {
    raw = await readFile(join(configDir, ".credentials.json"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw taggedRefreshFailure(`credential file unreadable (${code ?? "io_error"})`);
  }
  const credential = parseClaudeOauthCredential(raw);
  if (credential === null) {
    throw taggedRefreshFailure("credential file did not parse as a vendor credential");
  }
  return credential;
}

function taggedRefreshFailure(detail: string): Error {
  return Object.assign(new Error(detail), {
    quotaAbsenceReason: "refresh_failed" as QuotaAbsence["reason"],
  });
}

/** Accepts both credential shapes seen in the wild: flat and `{claudeAiOauth}`. */
export function parseClaudeOauthCredential(raw: string): ClaudeOauthCredential | null {
  try {
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
    const body = (
      parsed["claudeAiOauth"] && typeof parsed["claudeAiOauth"] === "object"
        ? parsed["claudeAiOauth"]
        : parsed
    ) as Record<string, unknown>;
    const token = body["accessToken"];
    if (typeof token !== "string" || token.length === 0) return null;
    return {
      accessToken: token,
      subscriptionType:
        typeof body["subscriptionType"] === "string" ? body["subscriptionType"] : null,
      expiresAtMs:
        typeof body["expiresAt"] === "number" && Number.isFinite(body["expiresAt"])
          ? body["expiresAt"]
          : null,
      hasRefreshToken: typeof body["refreshToken"] === "string" && body["refreshToken"].length > 0,
    };
  } catch {
    return null;
  }
}

/** A vendor rejection remembered per PRESENTED token (INV-062: the token's
 * hash, never the token; process memory only; never persisted or logged).
 * Re-presenting a credential the vendor has already rejected buys nothing and
 * costs a lot: the vendor answers a 401 storm with a one-hour 429, and the
 * per-vendor poll floor then blacks out every healthy sibling (live journal:
 * healthy profiles fresh 20 % of the day beside one revoked row). So a
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
) => Promise<ClaudeOauthCredential | null>;

/** Keep refresh-token custody and store writes inside Claude Code. Claudexor
 * wakes the vendor's prompt-free MCP server, observes expiry metadata, then
 * re-reads the access token only after the vendor has published fresh state. */
async function refreshCredentialDefault(
  configDir: string,
  platform: NodeJS.Platform,
  readCredential: typeof readClaudeOauthCredential,
): Promise<ClaudeOauthCredential | null> {
  const refreshed = await refreshClaudeNativeAuth(
    claudeNativeEnv(undefined, configDir),
    async () => (await readCredential(configDir, platform))?.expiresAtMs ?? null,
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
 * background cycles (see `rejectedTokens`); a foreground cycle re-asks unless
 * its poll floor remains active.
 * Absence is stated, never inferred. */
export async function refreshClaudeOauthUsageQuota(
  deps: Partial<ClaudeOauthUsageDeps> = {},
  cycle?: QuotaRefreshCycle,
): Promise<QuotaRefreshResult> {
  const readCredential = deps.readCredential ?? readClaudeOauthCredential;
  const refreshCredential = deps.refreshCredential ?? refreshCredentialDefault;
  const fetchUsage = deps.fetchUsage ?? fetchClaudeOauthUsage;
  const now = deps.now ?? (() => new Date());
  const platform = deps.platform ?? process.platform;
  // Rejections observed by THIS cycle count only if no credential change
  // intervened; one expired memory is released for re-verification per cycle.
  const epoch = rejectionEpoch;
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
  // Read all current identities before the serial HTTP pass so token-identical
  // aliases inherit a saved floor regardless of profile order after restart.
  const prepared: Array<{
    candidate: (typeof candidates)[number];
    credential: ClaudeOauthCredential;
  }> = [];
  for (const candidate of candidates) {
    let credential: ClaudeOauthCredential | null;
    try {
      credential = await readCredential(candidate.configDir, platform);
    } catch (error) {
      const tagged = (error as { quotaAbsenceReason?: QuotaAbsence["reason"] })?.quotaAbsenceReason;
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
      absences.push(
        claudeOauthAbsence(candidate.subjectId, "not_logged_in", notLoggedInDetail, now()),
      );
      continue;
    }
    prepared.push({ candidate, credential });
  }
  const subjectOf = (subjectId: string | null): QuotaSubject => ({
    harness: "claude",
    credential_route: "vendor_native",
    subject_id: subjectId,
    plan_label: null,
  });
  const bindCredentials = () =>
    cycle?.pacing?.bindCredentials(
      prepared.map(({ candidate, credential }) => ({
        subject: subjectOf(candidate.subjectId),
        credentialHash: sha256(credential.accessToken),
      })),
    );
  bindCredentials();
  const throttledTokens = new Set<string>();
  for (const item of prepared) {
    const { candidate } = item;
    let { credential } = item;
    const subject = subjectOf(candidate.subjectId);
    const pacedUntil = cycle?.pacing?.cooldownUntil(subject, now().getTime());
    if (pacedUntil !== null && pacedUntil !== undefined) {
      absences.push(
        claudeOauthAbsence(
          candidate.subjectId,
          "poll_paced",
          `quota poll paused by rate-limit cooldown until ${new Date(pacedUntil).toISOString()}`,
          now(),
        ),
      );
      continue;
    }
    if (throttledTokens.has(sha256(credential.accessToken))) {
      absences.push(
        claudeOauthAbsence(
          candidate.subjectId,
          "probe_skipped_rate_limited",
          "this token's oauth/usage probe hit the rate limit earlier in this cycle",
          now(),
        ),
      );
      continue;
    }
    // Retain the existing snapshot and its observation time when another
    // account's retry caused this background lane cycle. All current aliases
    // were bound above, and poll floors have already been honored.
    if (cycle?.shouldRefresh?.(subject) === false) continue;
    let beforeRequest = now();
    if (needsVendorRefresh(credential, beforeRequest)) {
      const originalCredentialStillValid =
        credential.expiresAtMs !== null && credential.expiresAtMs > beforeRequest.getTime();
      try {
        const refreshed = await refreshCredential(candidate.configDir, platform, readCredential);
        if (
          refreshed === null ||
          !claudeOauthAccessTokenIsFresh(refreshed.expiresAtMs, now().getTime())
        ) {
          throw taggedRefreshFailure(VENDOR_REFRESH_FAILED_DETAIL);
        }
        credential = refreshed;
        item.credential = refreshed;
        bindCredentials();
        beforeRequest = now();
      } catch (error) {
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
    try {
      const requestStartedAt = now();
      const usage = await fetchUsage(credential.accessToken);
      rejectedTokens.delete(tokenKey);
      const snapshot = parseClaudeOauthUsage(
        usage,
        candidate.subjectId,
        credential.subscriptionType,
        requestStartedAt,
      );
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
      // A 429 establishes only this credential's poll floor. Continue the
      // existing serial sweep for unrelated accounts; identical tokens share it.
      if (tagged === "rate_limited") {
        throttledTokens.add(tokenKey);
        cycle?.pacing?.noteRateLimited(subject, observedAt.getTime(), retryAfterMs ?? null);
      }
    }
  }
  return { snapshots, absences };
}
