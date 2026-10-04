import type { QuotaAbsence } from "@claudexor/schema";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const FETCH_TIMEOUT_MS = 10_000;

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

export async function fetchClaudeOauthUsage(
  accessToken: string,
  status?: (code: number) => void,
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
  status?.(res.status);
  // A 401 is tagged as the vendor rejecting the presented access token.
  // The caller owns the credential-expiry context: a token known to have
  // expired while refreshable is awaiting Claude Code's vendor-owned refresh,
  // not evidence that the account itself was revoked.
  if (res.status === 401) {
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
  // A 403 alone proves forbidden access, not a revoked credential. Unknown
  // permission/policy refusals and all other errors remain refresh failures.
  if (!res.ok) throw new Error(`oauth/usage responded ${res.status}`);
  return res.json();
}
