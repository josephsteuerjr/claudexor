import { describe, expect, it } from "vitest";
import {
  QuotaSnapshot as RawSnapshot,
  QuotaWindowObservation,
  quotaConstraintIdentity,
  quotaSnapshotIdentity,
  quotaSourceTraits,
  withQuotaAvailability,
  type QuotaConstraint,
  type QuotaSnapshot,
} from "./quota.js";

const constraint: QuotaConstraint = {
  id: "five_hour",
  label: "5 hours",
  used_ratio: 0.2,
  window_seconds: 18000,
  resets_at: "2026-10-05T00:00:00Z",
  cooldown_until: null,
};
const snapshot: QuotaSnapshot = {
  subject: {
    harness: "claude",
    credential_route: "vendor_native",
    subject_id: "work",
    plan_label: null,
  },
  source: "claude_rate_limit_event",
  observed_at: "2026-10-04T00:00:00Z",
  freshness: "fresh",
  constraints: [constraint],
};

describe("quota window identity", () => {
  it("changes only for the vendor window and applicability, not measurements", () => {
    const key = quotaConstraintIdentity(constraint);
    expect(
      quotaConstraintIdentity({
        ...constraint,
        used_ratio: 0.9,
        label: "Renamed",
        resets_at: null,
      }),
    ).toBe(key);
    expect(quotaConstraintIdentity({ ...constraint, id: "seven_day" })).not.toBe(key);
    expect(quotaConstraintIdentity({ ...constraint, window_seconds: 604800 })).not.toBe(key);
    const scoped = { ...constraint, applies_to_models: ["opus", "best", "opus"] };
    expect(quotaConstraintIdentity(scoped)).toBe(
      quotaConstraintIdentity({ ...scoped, applies_to_models: ["best", "opus"] }),
    );
    expect(quotaConstraintIdentity(scoped)).not.toBe(key);
    expect(quotaConstraintIdentity({ ...scoped, applies_to_unspecified_model: true })).not.toBe(
      quotaConstraintIdentity(scoped),
    );
  });

  it("includes family applicability without changing existing no-prefix identities", () => {
    const legacy = JSON.stringify([constraint.id, constraint.window_seconds, null, false]);
    expect(quotaConstraintIdentity(constraint)).toBe(legacy);
    expect(quotaConstraintIdentity({ ...constraint, applies_to_model_prefixes: [] })).toBe(legacy);
    const scoped = {
      ...constraint,
      applies_to_models: [],
      applies_to_model_prefixes: ["claude-", "gpt-", "claude-"],
    };
    expect(quotaConstraintIdentity(scoped)).toBe(
      quotaConstraintIdentity({ ...scoped, applies_to_model_prefixes: ["gpt-", "claude-"] }),
    );
    expect(quotaConstraintIdentity(scoped)).not.toBe(
      quotaConstraintIdentity({ ...scoped, applies_to_model_prefixes: ["gemini-"] }),
    );
    expect(quotaConstraintIdentity(scoped)).not.toBe(legacy);
    const scopedSnapshot = { ...snapshot, constraints: [scoped] };
    expect(quotaSnapshotIdentity(scopedSnapshot)).not.toBe(
      quotaSnapshotIdentity({
        ...scopedSnapshot,
        constraints: [{ ...scoped, applies_to_model_prefixes: ["gemini-"] }],
      }),
    );
    const full = { ...scopedSnapshot, source: "agy_command_usage" as const };
    expect(quotaSnapshotIdentity(full)).toBe(
      quotaSnapshotIdentity({
        ...full,
        constraints: [{ ...scoped, applies_to_model_prefixes: ["gemini-"] }],
      }),
    );
  });

  it("keeps full inventory slots stable and singleton observations independent", () => {
    const full = { ...snapshot, source: "claude_oauth_usage" as const };
    expect(quotaSnapshotIdentity({ ...full, constraints: [] })).toBe(quotaSnapshotIdentity(full));
    const reobserved: QuotaSnapshot = { ...snapshot, observed_at: "2026-10-04T01:00:00Z" };
    expect(quotaSnapshotIdentity(reobserved)).toBe(quotaSnapshotIdentity(snapshot));
    expect(
      quotaSnapshotIdentity({ ...snapshot, constraints: [{ ...constraint, id: "seven_day" }] }),
    ).not.toBe(quotaSnapshotIdentity(snapshot));
    for (const source of ["claude_rate_limit_event", "codex_app_server_event"] as const) {
      expect(quotaSourceTraits(source)).toEqual({
        snapshotMode: "window",
        vendorAuthenticated: false,
        refreshDemandHarness: null,
        producedByRefresher: false,
      });
    }
    expect(QuotaWindowObservation.safeParse({ version: 1, snapshot }).success).toBe(true);
    expect(QuotaWindowObservation.safeParse({ version: 1, snapshot: full }).success).toBe(false);
    expect(
      QuotaWindowObservation.safeParse({ version: 1, snapshot: { ...snapshot, constraints: [] } })
        .success,
    ).toBe(false);
  });

  it("derives a stable control identity without putting it into raw evidence", () => {
    const response = withQuotaAvailability({
      snapshots: [snapshot],
      absences: [],
      refreshed_at: null,
    });
    expect(response.snapshots[0]?.snapshot_id).toBe(quotaSnapshotIdentity(snapshot));
    expect(RawSnapshot.safeParse(response.snapshots[0]).success).toBe(false);
    expect(RawSnapshot.parse(snapshot)).toEqual(snapshot);
  });
});
