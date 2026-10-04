import { describe, expect, it } from "vitest";
import type { CredentialProfile, CredentialProfileStatus, HarnessEvent } from "@claudexor/schema";
import type { CredentialExecutionSubject } from "@claudexor/core";
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
const subject: CredentialExecutionSubject = {
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
  const bind = (offset: number, extra: Partial<CredentialExecutionSubject> = {}) => {
    at(offset);
    return createCredentialExecutionObserver(ledger, ledger.bind({ ...subject, ...extra }));
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
  const refuse = (
    observer: ReturnType<typeof bind>,
    offset: number,
    extra: Partial<HarnessEvent> = {},
  ) =>
    observer.observe(
      event("error", offset, {
        status: { kind: "api_retry", error_category: "authentication_failed" },
        ...extra,
      }),
    );
  const serve = (
    observer: ReturnType<typeof bind>,
    offset: number,
    extra: Partial<HarnessEvent> = {},
  ) =>
    observer.observe(
      event("usage", offset, {
        observed_model: "model-a",
        usage: { input_tokens: 1, output_tokens: 1 },
        ...extra,
      }),
    );
  const finish = (
    observer: ReturnType<typeof bind>,
    offset: number,
    exit: number,
    extra: Partial<HarnessEvent> = {},
  ) => {
    observer.observe(event("completed", offset, { payload: { exit_code: exit }, ...extra }));
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

async function expectBlocked(f: ReturnType<typeof fixture>, offset?: number) {
  expect(f.ledger.live()).toHaveLength(1);
  if (offset !== undefined)
    expect(f.ledger.live()[0]).toMatchObject({
      observed_at: f.stamp(offset),
      expires_at: f.stamp(offset + 6 * 3600000),
      source: "attempt_stream",
      code: "auth_revoked",
    });
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
        await expectBlocked(f, variant === "order" ? 200 : 300);
      }
    },
  );

  function permutations<T>(values: readonly T[]): T[][] {
    return values.length === 0
      ? [[]]
      : values.flatMap((value, index) =>
          permutations(values.filter((_, other) => other !== index)).map((tail) => [
            value,
            ...tail,
          ]),
        );
  }

  it.each(permutations(["A", "B", "C", "D"] as const))(
    "gap contact, finish %s,%s,%s,%s, cannot heal the complete negative boundary",
    async (...delivery) => {
      for (const variant of ["order", "time"] as const) {
        const f = fixture();
        const A = f.bind(0),
          middle = f.bind(10),
          B = f.bind(20),
          last = f.bind(30);
        const C = variant === "order" ? middle : last;
        const D = variant === "order" ? last : middle;
        if (variant === "order") {
          f.refuse(B, 100);
          f.serve(D, 150);
          f.refuse(A, 200);
          f.serve(C, 300);
        } else {
          f.refuse(B, 200);
          f.serve(C, 250);
          f.refuse(A, 300);
          f.serve(D, 400);
        }
        const observers = { A, B, C, D };
        delivery.forEach((name, index) =>
          f.finish(observers[name], 600 + index * 10, name === "A" || name === "B" ? 1 : 0),
        );
        await expectBlocked(f, variant === "order" ? 200 : 300);
      }
    },
  );

  it.each(deliveries)(
    "incomparable real recovery survives finish %s,%s,%s",
    async (...delivery) => {
      const f = fixture();
      const A = f.bind(0),
        C = f.bind(10),
        B = f.bind(20);
      f.serve(B, 100);
      f.refuse(A, 200);
      f.serve(C, 500);
      const observers = { A, B, C };
      delivery.forEach((name, index) =>
        f.finish(observers[name], 600 + index * 10, name === "A" ? 1 : 0),
      );
      expect(f.ledger.live()).toEqual([]);
      expect(f.ledger.honored().map((item) => item.observed_at)).toEqual([
        f.stamp(500),
        f.stamp(500),
      ]);
      expect(f.composed()).toMatchObject({
        verification: "passed",
        last_verified_at: f.stamp(500),
      });
      expect(await f.admission()).toBe("available");
    },
  );

  it.each(deliveries)(
    "separate successful order and contact time never invent a recovery, finish %s,%s,%s",
    async (...delivery) => {
      const f = fixture();
      f.bind(0);
      f.bind(10);
      const C = f.bind(20),
        A = f.bind(30),
        B = f.bind(40);
      f.serve(B, 100);
      f.refuse(A, 200);
      f.serve(C, 500);
      const observers = { A, B, C };
      delivery.forEach((name, index) =>
        f.finish(observers[name], 600 + index * 10, name === "A" ? 1 : 0),
      );
      await expectBlocked(f, 200);
    },
  );
});

describe("bounded recovery proof forgetting", () => {
  function otherAccounts(f: ReturnType<typeof fixture>, count: number, start: number) {
    for (let index = 0; index < count; index++) {
      const profileId = `other-${index}`;
      const offset = start + index * 10;
      const observer = f.bind(offset, { profileId });
      const identity = { credential_profile_id: profileId };
      f.serve(observer, offset + 1, identity);
      f.finish(observer, offset + 2, 0, identity);
    }
  }

  function heal(f: ReturnType<typeof fixture>) {
    const failed = f.bind(0);
    f.refuse(failed, 10);
    f.finish(failed, 20, 1);
    const recovered = f.bind(30);
    f.serve(recovered, 40);
    f.finish(recovered, 50, 0);
  }

  it("33 successful accounts cannot resurrect a healed refusal; a fresh refusal still blocks", async () => {
    const f = fixture();
    heal(f);
    expect(f.composed().verification).toBe("passed");
    expect(await f.admission()).toBe("available");
    otherAccounts(f, 32, 60);
    expect(f.ledger.honored()).toHaveLength(64);
    expect(f.ledger.honored().filter((point) => point.profile_id === "work")).toEqual([]);
    expect(f.ledger.live()).toEqual([]);
    expect(f.composed().verification).toBe("passed");
    expect(await f.admission()).toBe("available");
    const failed = f.bind(2000);
    f.refuse(failed, 2100);
    f.finish(failed, 2200, 1);
    expect(f.composed().verification).toBe("failed");
    expect(await f.admission()).toContain("unusable");
    const recovered = f.bind(3000);
    f.serve(recovered, 3100);
    f.finish(recovered, 3110, 0);
    expect(f.composed().verification).toBe("passed");
    expect(await f.admission()).toBe("available");
  });

  it("capacity forgetting preserves unhealed route and actual-model scopes", async () => {
    const f = fixture();
    heal(f);
    const api = f.bind(60, { route: "managed_api_key" });
    f.refuse(api, 70, { credential_route: "managed_api_key" });
    f.finish(api, 80, 1, { credential_route: "managed_api_key" });
    const model = f.bind(90, { requestedModel: "model-b" });
    f.refuse(model, 100, { status: { kind: "api_retry", error_category: "model_not_found" } });
    f.finish(model, 110, 1);
    otherAccounts(f, 32, 200);
    expect(f.ledger.live()).toMatchObject([
      { credential_route: "managed_api_key", code: "auth_revoked", model: null },
      { credential_route: "vendor_native", code: "capability_refused", model: "model-b" },
    ]);
    expect(f.ledger.live()).toHaveLength(2);
    expect(f.composed().verification).toBe("passed");
    expect(await f.admission()).toBe("available");
    const quota = { snapshots: [], absences: [], honored: f.ledger.honored() };
    for (const scope of [
      { route: "vendor_native" as const, model: "model-b", profile },
      {
        route: "managed_api_key" as const,
        model: "model-a",
        profile: {
          ...profile,
          credential_kind: "api_key" as const,
          isolation_locator: null,
          secret_ref: "fixture",
        },
      },
    ]) {
      expect(
        composeCredentialProfileEvidence(status, {
          quota,
          unusable: f.ledger.live(),
          route: scope.route,
          model: scope.model,
        }).verification,
      ).toBe("failed");
      expect(
        await selectedProfileAvailability({
          registry: [scope.profile],
          profileId: "work",
          harnessId: "claude",
          model: scope.model,
          probe: async () => status,
          quota,
          unusable: f.ledger.live(),
        }),
      ).toContain("unusable");
    }
  });

  it("another actual covering point retains the witness for later concurrent refusal", async () => {
    const f = fixture();
    const A = f.bind(0);
    f.bind(10);
    const Q = f.bind(20),
      P = f.bind(30),
      B = f.bind(40),
      D = f.bind(50);
    f.refuse(B, 100);
    f.serve(D, 150);
    f.refuse(A, 200);
    f.serve(P, 300);
    f.serve(Q, 400);
    f.finish(A, 500, 1);
    f.finish(P, 510, 0);
    f.finish(Q, 520, 0);
    otherAccounts(f, 31, 1000);
    expect(
      f.ledger
        .honored()
        .filter((point) => point.profile_id === "work")
        .map((point) => point.observed_at),
    ).toEqual([f.stamp(400), f.stamp(400)]);
    expect(f.ledger.live()).toEqual([]);
    expect(f.composed().verification).toBe("passed");
    expect(await f.admission()).toBe("available");
    f.finish(B, 2000, 1);
    f.finish(D, 2010, 0);
    expect(f.ledger.live()[0]).toMatchObject({
      observed_at: f.stamp(200),
      expires_at: f.stamp(200 + 6 * 3600000),
    });
    expect(f.composed().verification).toBe("failed");
    expect(await f.admission()).toContain("unusable");
    const recovered = f.bind(3000);
    f.serve(recovered, 3100);
    f.finish(recovered, 3110, 0);
    expect(f.composed().verification).toBe("passed");
    expect(await f.admission()).toBe("available");
  });
});
