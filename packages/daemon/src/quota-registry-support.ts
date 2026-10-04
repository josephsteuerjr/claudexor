/**
 * Pure per-snapshot helpers of the QuotaRegistry, split to a smaller owner
 * (complexity ratchet): durable-journal v3.2.0 rollback shaping, snapshot
 * keying, freshness aging, and expired scoped-cooldown pruning. No registry
 * state lives here.
 */
import {
  REACTIVE_COOLDOWN_SOURCE,
  legacyV320QuotaSource,
  quotaSnapshotIdentity,
  vendorResetDayCooldownEnd,
  type CredentialRoute,
  type HarnessEvent,
  type QuotaConstraint,
  type QuotaSnapshot,
  type QuotaSource,
} from "@claudexor/schema";
import { hashJson } from "@claudexor/util";

/** The reactive vendor-limit cooldown snapshot for a harness event: the
 * existing subject's constraints minus the superseded/expired cooldown, plus
 * the new bounded cooldown window. Pure: the registry finds `existing`. */
export function reactiveCooldownSnapshot(
  input: {
    harness: string;
    credentialRoute: CredentialRoute;
    event: HarnessEvent;
    source: QuotaSource;
    existing: QuotaSnapshot | undefined;
  },
  now: Date,
): QuotaSnapshot {
  const { harness, credentialRoute, event, source, existing } = input;
  const reset = event.rate_limit?.resets_at ?? null;
  const delay = event.rate_limit?.retry_delay_ms ?? null;
  // A day-granular vendor reset (A1 payload) bounds the cooldown at end-of-day UTC.
  const cooldownUntil =
    reset ??
    vendorResetDayCooldownEnd(event.payload) ??
    new Date(now.getTime() + (typeof delay === "number" ? delay : 5 * 60_000)).toISOString();
  const constraintId = event.rate_limit?.constraint_id
    ? `cooldown:${event.rate_limit.constraint_id}`
    : "cooldown";
  return {
    subject: existing?.subject ?? {
      harness,
      credential_route: credentialRoute,
      plan_label: null,
      subject_id: event.credential_profile_id ?? null,
    },
    source,
    observed_at: event.ts,
    freshness: "fresh",
    constraints: [
      ...(existing?.constraints.filter(
        (constraint) =>
          constraint.id !== constraintId &&
          !isExpiredScopedCooldown(source, constraint, now.getTime()),
      ) ?? []),
      {
        id: constraintId,
        label: "Cooldown",
        ...(event.rate_limit?.applies_to_models !== undefined
          ? { applies_to_models: event.rate_limit.applies_to_models }
          : {}),
        used_ratio: null,
        window_seconds: null,
        resets_at: reset,
        cooldown_until: cooldownUntil,
      },
    ],
  };
}

export const QUOTA_FRESHNESS_TTL_MS = 5 * 60_000;

/** Same quota EVIDENCE: everything but the observation time (a freshness flip
 * is evidence). A poll that only re-observed unchanged evidence keeps the fresh
 * `observed_at` in memory without a journal frame. */
export function sameQuotaEvidence(a: QuotaSnapshot, b: QuotaSnapshot): boolean {
  return hashJson({ ...a, observed_at: null }) === hashJson({ ...b, observed_at: null });
}

export function snapshotKey(snapshot: QuotaSnapshot): string {
  return quotaSnapshotIdentity(snapshot);
}

/** Exact durable payload accepted by the strict v3.2.0 quota schemas. Keep an
 * explicit allowlist at every nested level so a future additive field cannot
 * silently make updater rollback boot-incompatible again. */
export function legacyV320Snapshot(snapshot: QuotaSnapshot): QuotaSnapshot {
  return {
    subject: {
      harness: snapshot.subject.harness,
      credential_route: snapshot.subject.credential_route,
      plan_label: snapshot.subject.plan_label,
      subject_id: snapshot.subject.subject_id,
    },
    constraints: snapshot.constraints.map((constraint): QuotaConstraint => ({
      id: constraint.id,
      label: constraint.label,
      used_ratio: constraint.used_ratio,
      window_seconds: constraint.window_seconds,
      resets_at: constraint.resets_at,
      cooldown_until: constraint.cooldown_until,
    })),
    source: legacyV320QuotaSource(snapshot.source),
    observed_at: snapshot.observed_at,
    freshness: snapshot.freshness,
  };
}

export function staleAt(snapshot: QuotaSnapshot, now: number): QuotaSnapshot {
  if (snapshot.freshness !== "fresh") return snapshot;
  const observed = Date.parse(snapshot.observed_at);
  const resetExpired = snapshot.constraints.some((constraint) => resetExpiredAt(constraint, now));
  const tooOld = !Number.isFinite(observed) || now - observed > QUOTA_FRESHNESS_TTL_MS;
  return resetExpired || tooOld ? { ...snapshot, freshness: "stale" } : snapshot;
}

/** The instant at which a fresh snapshot stops satisfying primary demand: its
 * TTL expiry or its earliest reset boundary, whichever comes first. A stale or
 * unreadable observation is already due (-Infinity). One owner for "when is
 * this evidence due" — the demand horizon check and the lane renewal cap both
 * read it, so they can never disagree by a tick. */
export function quotaSnapshotDueAt(snapshot: QuotaSnapshot): number {
  if (snapshot.freshness !== "fresh") return Number.NEGATIVE_INFINITY;
  const observed = Date.parse(snapshot.observed_at);
  if (!Number.isFinite(observed)) return Number.NEGATIVE_INFINITY;
  const resets = snapshot.constraints
    .map((constraint) => (constraint.resets_at ? Date.parse(constraint.resets_at) : Number.NaN))
    .filter((at) => Number.isFinite(at));
  return Math.min(observed + QUOTA_FRESHNESS_TTL_MS, ...resets);
}

/** Whether primary evidence will be due by a future demand horizon. Unlike
 * `staleAt`, the TTL comparison includes equality so the last existing poll
 * before expiry requests renewal instead of waiting for the following tick. */
export function quotaSnapshotDueBefore(snapshot: QuotaSnapshot, deadline: number): boolean {
  return quotaSnapshotDueAt(snapshot) <= deadline;
}

function resetExpiredAt(constraint: Pick<QuotaConstraint, "resets_at">, now: number): boolean {
  const reset = constraint.resets_at ? Date.parse(constraint.resets_at) : Number.NaN;
  return Number.isFinite(reset) && reset <= now;
}

export function isExpiredScopedCooldown(
  source: QuotaSnapshot["source"],
  constraint: QuotaConstraint,
  now: number,
): boolean {
  // Every reactive cooldown source (the upsertCooldown producers), not a claude-only
  // name check: an expired scoped sibling never hides a newer active one (Q24 generalized).
  return (
    Object.values(REACTIVE_COOLDOWN_SOURCE).includes(source) &&
    constraint.id.startsWith("cooldown:") &&
    resetExpiredAt(constraint, now)
  );
}

export function withoutExpiredScopedCooldowns(
  snapshot: QuotaSnapshot,
  now: number,
): QuotaSnapshot | null {
  const constraints = snapshot.constraints.filter(
    (constraint) => !isExpiredScopedCooldown(snapshot.source, constraint, now),
  );
  if (constraints.length === snapshot.constraints.length) return snapshot;
  return constraints.length === 0 ? null : { ...snapshot, constraints };
}
