import { describe, expect, it } from "vitest";
import type { CredentialProfile, CredentialProfileStatus, HarnessEvent } from "@claudexor/schema";
import { CredentialUnusableLedger } from "../../daemon/src/credential-unusable-ledger.js";
import { createCredentialExecutionObserver } from "./credential-execution.js";
import { composeCredentialProfileEvidence } from "./account-evidence.js";
import { selectedProfileAvailability } from "./credential-profiles.js";

const profile: CredentialProfile = {
  profile_id: "work",
  harness_id: "claude",
  display_name: "Work",
  credential_kind: "config_dir_login",
  isolation_locator: "/fixture/work",
  secret_ref: null,
  enabled: true,
  created_at: null,
};
const status: CredentialProfileStatus = {
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
  let clock = t0;
  const ledger = new CredentialUnusableLedger(
    () => new Date(clock),
    () => false,
  );
  const stamp = (offset: number) => new Date(t0 + offset).toISOString();
  const at = (offset: number) => {
    clock = t0 + offset;
    return stamp(offset);
  };
  const bind = (offset: number) => {
    at(offset);
    return createCredentialExecutionObserver(ledger, ledger.bind(subject));
  };
  const event = (
    type: HarnessEvent["type"],
    offset: number,
    extra: Partial<HarnessEvent> = {},
  ): HarnessEvent => ({
    type,
    session_id: "fixture",
    ts: at(offset),
    credential_route: "vendor_native",
    credential_profile_id: "work",
    ...extra,
  });
  const refuse = (observer: ReturnType<typeof bind>, offset: number) =>
    observer.observe(
      event("error", offset, {
        status: { kind: "api_retry", error_category: "authentication_failed" },
      }),
    );
  const serve = (observer: ReturnType<typeof bind>, offset: number) =>
    observer.observe(
      event("usage", offset, {
        observed_model: "model-a",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  const finish = (observer: ReturnType<typeof bind>, offset: number, exit: number) => {
    observer.observe(event("completed", offset, { payload: { exit_code: exit } }));
    observer.finish();
  };
  const quota = () => ({ snapshots: [], absences: [], honored: ledger.honored() });
  const composed = () =>
    composeCredentialProfileEvidence(status, {
      quota: quota(),
      unusable: ledger.live(),
      route: "vendor_native",
    });
  const admission = () =>
    selectedProfileAvailability({
      registry: [profile],
      profileId: "work",
      harnessId: "claude",
      model: "model-a",
      probe: async () => status,
      quota: quota(),
      unusable: ledger.live(),
    });
  const recover = () => {
    const observer = bind(1000);
    serve(observer, 1100);
    finish(observer, 1110, 0);
  };
  return { ledger, stamp, bind, refuse, serve, finish, composed, admission, recover };
}

async function expectBlocked(f: ReturnType<typeof fixture>) {
  expect(f.ledger.live()).toHaveLength(1);
  expect(f.ledger.honored()).toEqual([]);
  expect(f.composed().verification).toBe("failed");
  expect(await f.admission()).toContain("unusable");
  f.recover();
  expect(f.ledger.live()).toEqual([]);
  expect(f.composed().verification).toBe("passed");
  expect(await f.admission()).toBe("available");
}

describe("independent negative order and observation boundaries", () => {
  it("a later old-dispatch refusal never releases the newer-dispatch boundary", async () => {
    const f = fixture();
    const A = f.bind(0),
      C = f.bind(10),
      B = f.bind(20);
    f.refuse(B, 100);
    f.finish(B, 110, 1);
    f.refuse(A, 200);
    f.finish(A, 210, 1);
    f.serve(C, 300);
    f.finish(C, 310, 0);
    expect(f.ledger.live()[0]).toMatchObject({
      source: "attempt_stream",
      code: "auth_revoked",
      observed_at: f.stamp(200),
      expires_at: f.stamp(200 + 6 * 3600000),
    });
    await expectBlocked(f);
  });

  it("a delayed earlier refusal never lowers the latest actual contact boundary", async () => {
    const f = fixture();
    const A = f.bind(0),
      B = f.bind(10),
      C = f.bind(20);
    f.refuse(B, 200);
    f.serve(C, 250);
    f.refuse(A, 300);
    f.finish(A, 310, 1);
    f.finish(B, 400, 1);
    f.finish(C, 450, 0);
    expect(f.ledger.live()[0]).toMatchObject({
      observed_at: f.stamp(300),
      expires_at: f.stamp(300 + 6 * 3600000),
    });
    await expectBlocked(f);
  });

  const deliveries = [
    ["A", "B", "C"],
    ["A", "C", "B"],
    ["B", "A", "C"],
    ["B", "C", "A"],
    ["C", "A", "B"],
    ["C", "B", "A"],
  ] as const;
  it.each(deliveries)(
    "terminal delivery order %s,%s,%s preserves the combined refusal",
    async (first, second, third) => {
      for (const variant of ["order", "time"] as const) {
        const f = fixture();
        const A = f.bind(0),
          middle = f.bind(10),
          last = f.bind(20);
        const B = variant === "order" ? last : middle;
        const C = variant === "order" ? middle : last;
        if (variant === "order") {
          f.refuse(B, 100);
          f.refuse(A, 200);
          f.serve(C, 300);
        } else {
          f.refuse(B, 200);
          f.serve(C, 250);
          f.refuse(A, 300);
        }
        const observers = { A, B, C };
        [first, second, third].forEach((name, index) =>
          f.finish(observers[name], 500 + index * 10, name === "C" ? 0 : 1),
        );
        await expectBlocked(f);
      }
    },
  );
});
