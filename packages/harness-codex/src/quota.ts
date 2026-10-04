import type { HarnessEvent, QuotaConstraint, QuotaSnapshot } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

/** Full inventory reads may clear old restrictions, so malformed/unknown
 * envelopes cannot acquire the authority of a successful empty inventory. */
export function parseCodexRateLimitsResponse(
  value: unknown,
  observedAt: Date,
  subjectId: string | null = null,
): QuotaSnapshot[] {
  const response = objectOrNull(value);
  if (!response) throw new Error("Codex quota response is not an object");
  const buckets = fullRateLimitBuckets(response);
  for (const [, bucket] of buckets) {
    for (const [windowName, candidate] of Object.entries(bucket)) {
      const window = objectOrNull(candidate);
      if (
        (windowName === "primary" || windowName === "secondary") &&
        candidate !== null &&
        (!window || !isRateLimitWindow(window))
      ) {
        throw new Error("Codex quota response contains an unrecognized window");
      }
      if (!window || !isRateLimitWindow(window)) continue;
      for (const key of ["usedPercent", "windowDurationMins", "resetsAt"]) {
        if (key in window && window[key] !== null && finiteNumber(window[key]) === null)
          throw new Error("Codex quota response contains a malformed window");
      }
    }
  }
  return parseCodexRateLimits(
    { ...response, rateLimitsByLimitId: Object.fromEntries(buckets) },
    observedAt,
    subjectId,
  );
}

/** Numeric codec shared by validated full reads and tolerant notifications. */
function parseCodexRateLimits(
  value: unknown,
  observedAt: Date,
  subjectId: string | null = null,
): QuotaSnapshot[] {
  if (!value || typeof value !== "object") return [];
  const response = value as Record<string, unknown>;
  const historical = objectOrNull(response["rateLimits"]);
  const buckets = rateLimitBuckets(response);
  const constraints: QuotaConstraint[] = [];
  for (const [fallbackId, bucket] of buckets) {
    const bucketId = textOrNull(bucket["limitId"]) ?? fallbackId;
    const bucketLabel = textOrNull(bucket["limitName"]) ?? bucketId;
    for (const [windowName, candidate] of Object.entries(bucket)) {
      const window = objectOrNull(candidate);
      if (!window || !isRateLimitWindow(window)) continue;
      const usedPercent = finiteNumber(window["usedPercent"]);
      const durationMins = finiteNumber(window["windowDurationMins"]);
      const resetSeconds = finiteNumber(window["resetsAt"]);
      constraints.push({
        id: `${bucketId}:${windowName}`,
        label: `${bucketLabel} ${windowName}`,
        used_ratio: usedPercent === null ? null : Math.min(1, Math.max(0, usedPercent / 100)),
        window_seconds:
          durationMins !== null && durationMins > 0 && Number.isFinite(durationMins * 60)
            ? durationMins * 60
            : null,
        resets_at: resetTime(resetSeconds),
        cooldown_until: null,
      });
    }
  }
  // Live-verified shape (codex 0.142.2, 2026-07-17): a TOP-LEVEL
  // `rateLimitResetCredits: {availableCount, credits[]}` beside the buckets
  // (PR#28143). Zero credits stay silent; a positive balance is a visible
  // fact row so the footer never hides granted headroom.
  const resetCredits = objectOrNull(response["rateLimitResetCredits"]);
  const availableCredits = resetCredits ? finiteNumber(resetCredits["availableCount"]) : null;
  if (availableCredits !== null && availableCredits > 0) {
    constraints.push({
      id: "reset_credits",
      label: `${availableCredits} reset credit${availableCredits === 1 ? "" : "s"} available`,
      used_ratio: null,
      window_seconds: null,
      resets_at: null,
      cooldown_until: null,
    });
  }
  return [
    {
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: historical ? textOrNull(historical["planType"]) : null,
        subject_id: subjectId,
      },
      constraints,
      source: "codex_app_server",
      observed_at: observedAt.toISOString(),
      freshness: "fresh",
    },
  ];
}

/** Notifications update their reported windows only; they do not replace the
 * full inventory or certify another bucket's unknown model applicability. */
export function codexRateLimitEvents(value: unknown, sessionId: string): HarnessEvent[] {
  const response = objectOrNull(value);
  if (!response) return [];
  const ts = nowIso();
  return rateLimitBuckets(response).flatMap(([fallbackId, bucket]) => {
    const id = textOrNull(bucket["limitId"]) ?? fallbackId;
    const [snapshot] = parseCodexRateLimits(
      { rateLimits: { ...bucket, limitId: id } },
      new Date(ts),
    );
    return (snapshot?.constraints ?? []).map((constraint): HarnessEvent => {
      const event: HarnessEvent = { type: "status", session_id: sessionId, ts };
      // The ordinary Codex bucket is account-wide. A named additional bucket
      // is not a model alias contract; retain its evidence without inventing one.
      if (id === "codex" || id === "default") {
        event.quota = {
          source: "codex_app_server_event",
          plan_label: snapshot?.subject.plan_label ?? null,
          subject_id: null,
          constraints: [constraint],
        };
      } else {
        event.payload = {
          native_quota: {
            source: "codex_app_server_event",
            window_id: redactSecrets(constraint.id).slice(0, 160),
            used_ratio: constraint.used_ratio,
            window_seconds: constraint.window_seconds,
            resets_at: constraint.resets_at,
            applicability: "unknown",
          },
        };
      }
      return event;
    });
  });
}

function fullRateLimitBuckets(
  response: Record<string, unknown>,
): Array<[string, Record<string, unknown>]> {
  const byId = response["rateLimitsByLimitId"];
  if (byId !== undefined && byId !== null) {
    const buckets = objectOrNull(byId);
    if (!buckets) throw new Error("Codex quota response contains a malformed bucket map");
    if (Object.keys(buckets).length > 0) {
      return Object.entries(buckets).map(([id, value]) => [id, recognizedRateLimitBucket(value)]);
    }
    if (response["rateLimits"] === undefined || response["rateLimits"] === null) return [];
  }
  if (response["rateLimits"] === null) return [];
  if (response["rateLimits"] !== undefined) {
    const bucket = recognizedRateLimitBucket(response["rateLimits"]);
    return [[textOrNull(bucket["limitId"]) ?? "default", bucket]];
  }
  throw new Error("Codex quota response contains no recognized rate limits");
}

function recognizedRateLimitBucket(value: unknown): Record<string, unknown> {
  const bucket = objectOrNull(value);
  if (
    !bucket ||
    !(
      "primary" in bucket ||
      "secondary" in bucket ||
      textOrNull(bucket["limitId"]) ||
      textOrNull(bucket["planType"]) ||
      Object.values(bucket).some((item) => {
        const window = objectOrNull(item);
        return window !== null && isRateLimitWindow(window);
      })
    )
  ) {
    throw new Error("Codex quota response contains an unrecognized bucket");
  }
  return bucket;
}

function rateLimitBuckets(response: Record<string, unknown>) {
  const byId = objectOrNull(response["rateLimitsByLimitId"]);
  const historical = objectOrNull(response["rateLimits"]);
  return byId
    ? Object.entries(byId).flatMap(([id, value]) => {
        const bucket = objectOrNull(value);
        return bucket ? [[id, bucket] as const] : [];
      })
    : historical
      ? [[textOrNull(historical["limitId"]) ?? "default", historical] as const]
      : [];
}

function resetTime(seconds: number | null): string | null {
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isRateLimitWindow(value: Record<string, unknown>): boolean {
  return ["usedPercent", "windowDurationMins", "resetsAt"].some((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
