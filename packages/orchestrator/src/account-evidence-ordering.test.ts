import { describe, expect, it } from "vitest";
import type {
  CredentialProfile,
  CredentialProfileStatus,
  CredentialUnusableObservation,
  QuotaSnapshot,
} from "@claudexor/schema";
import { CredentialUnusableLedger } from "../../daemon/src/credential-unusable-ledger.js";
import { composeCredentialProfileEvidence } from "./account-evidence.js";
import { selectedProfileAvailability, vendorCredentialObservation } from "./credential-profiles.js";
import { profileBillingVerification } from "./auth-route-classification.js";
import { billingKnowledgeForAuthRoute } from "@claudexor/budget";

const profile: CredentialProfile = {
  profile_id: "work",
  harness_id: "claude",
  display_name: "Work",
  credential_kind: "config_dir_login",
  isolation_locator: "/tmp/work",
  secret_ref: null,
  enabled: true,
  created_at: null,
};
const passing: CredentialProfileStatus = {
  profile_id: "work",
  harness_id: "claude",
  availability: "available",
  verification: "passed",
  verification_source: "local_store",
  last_verified_at: null,
};
const subject = {
  harnessId: "claude",
  profileId: "work",
  route: "vendor_native" as const,
  requestedModel: "model-a",
};

function fixture() {
  const t0 = Date.now();
  let now = t0;
  const ledger = new CredentialUnusableLedger(() => new Date(now));
  const at = (offset: number) => {
    now = t0 + offset;
    return new Date(now).toISOString();
  };
  const refusal = (offset: number): CredentialUnusableObservation => ({
    harness_id: "claude",
    profile_id: "work",
    credential_route: "vendor_native",
    model: null,
    code: "auth_revoked",
    source: "attempt_stream",
    detail: "refused",
    observed_at: at(offset),
    expires_at: new Date(t0 + 3600000).toISOString(),
  });
  const context = (snapshots: QuotaSnapshot[] = []) => ({
    snapshots,
    absences: [],
    honored: ledger.honored(),
  });
  const composed = (snapshots: QuotaSnapshot[] = []) =>
    composeCredentialProfileEvidence(passing, {
      quota: context(snapshots),
      unusable: ledger.live(),
      route: "vendor_native",
    });
  const admission = (snapshots: QuotaSnapshot[] = []) =>
    selectedProfileAvailability({
      registry: [profile],
      harnessId: "claude",
      profileId: "work",
      model: "model-a",
      probe: async () => passing,
      quota: context(snapshots),
      unusable: ledger.live(),
    });
  return { ledger, at, refusal, context, composed, admission };
}

describe("credential ordering reaches composition and admission", () => {
  it("old dispatch success after newer refusal never exports recovering proof", async () => {
    const f = fixture();
    const older = f.ledger.bind(subject),
      newer = f.ledger.bind(subject);
    f.ledger.recordBound(newer, f.refusal(1000));
    f.ledger.honorBound(older, "model-a", f.at(2000));
    expect(f.ledger.live()).toHaveLength(1);
    expect(f.ledger.honored()).toEqual([]);
    expect(f.composed().verification).toBe("failed");
    expect(await f.admission()).toContain("unusable");
    const partial: QuotaSnapshot = {
      subject: {
        harness: "claude",
        credential_route: "vendor_native",
        subject_id: "work",
        plan_label: null,
      },
      source: "claude_rate_limit_event",
      observed_at: f.at(3000),
      freshness: "fresh",
      constraints: [
        {
          id: "five_hour",
          label: "5h",
          used_ratio: 0.2,
          window_seconds: 18000,
          resets_at: null,
          cooldown_until: null,
        },
      ],
    };
    expect(f.composed([partial]).verification).toBe("failed");
    expect(await f.admission([partial])).toContain("unusable");
    f.ledger.honorBound(f.ledger.bind(subject), "model-a", f.at(4000));
    expect(f.composed().verification).toBe("passed");
    expect(await f.admission()).toBe("available");
  });

  it("retained success is not exported over a subsequent current refusal", async () => {
    const f = fixture();
    const old = f.ledger.bind(subject);
    f.ledger.honorBound(old, "model-a", f.at(1000));
    expect(f.ledger.honored()).toHaveLength(2);
    f.ledger.recordBound(f.ledger.bind(subject), f.refusal(2000));
    expect(f.ledger.honored()).toEqual([]);
    expect(f.composed().verification).toBe("failed");
    expect(await f.admission()).toContain("unusable");
  });

  it("real refusal after later-dispatch success is kept; a delayed older observation is ignored", async () => {
    const f = fixture();
    const old = f.ledger.bind(subject),
      newer = f.ledger.bind(subject);
    const delayed = f.refusal(500);
    f.ledger.honorBound(newer, "model-a", f.at(1000));
    f.ledger.recordBound(old, delayed);
    expect(f.ledger.live()).toEqual([]);
    f.ledger.recordBound(old, f.refusal(2000));
    expect(f.ledger.live()).toHaveLength(1);
    expect(f.ledger.honored()).toEqual([]);
    expect(f.composed().verification).toBe("failed");
    expect(await f.admission()).toContain("unusable");
  });

  it("full vendor recovery and subscription proof survive numeric quota aging", async () => {
    const f = fixture();
    f.ledger.record(f.refusal(0));
    const full: QuotaSnapshot = {
      subject: {
        harness: "claude",
        credential_route: "vendor_native",
        subject_id: "work",
        plan_label: null,
      },
      source: "claude_oauth_usage",
      observed_at: f.at(1000),
      freshness: "stale",
      constraints: [],
    };
    expect(f.composed([full])).toMatchObject({
      verification: "passed",
      verification_source: "vendor",
      last_verified_at: full.observed_at,
    });
    expect(await f.admission([full])).toBe("available");
    expect(profileBillingVerification(f.composed([full]))).toBe("passed");
    expect(
      billingKnowledgeForAuthRoute({
        route: "vendor_native",
        verification: profileBillingVerification(f.composed([full])),
      }),
    ).toBe("subscription_entitlement");
    const quota = {
      snapshots: [full],
      absences: [
        {
          subject: full.subject,
          reason: "auth_revoked" as const,
          detail: "old",
          observed_at: new Date(Date.parse(full.observed_at) - 1).toISOString(),
        },
      ],
    };
    expect(vendorCredentialObservation(quota, "claude", "work")).toEqual({
      outcome: "honored",
      observed_at: full.observed_at,
    });
    expect(
      composeCredentialProfileEvidence(
        { ...passing, verification: "failed" },
        { quota, unusable: [], route: "vendor_native" },
      ).verification,
    ).toBe("failed");
    expect(full.freshness).toBe("stale");
  });
});
