import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeHarness } from "@claudexor/harness-fake";
import { CredentialProfile, type CredentialProfileStatus } from "@claudexor/schema";
import {
  accountObservations,
  displayAccountObservation,
  retainAccountProbeObservations,
} from "./account-observations.js";

beforeEach(() => accountObservations.invalidate());

function fixture(kind: "profile" | "account", harness = "fake-success", profileId = "account") {
  const profile = CredentialProfile.parse({
    profile_id: profileId,
    harness_id: harness,
    credential_kind: "config_dir_login",
    display_name: "Observation fixture",
    isolation_locator: "/observation-fixture",
  });
  const status: CredentialProfileStatus = {
    profile_id: profileId,
    harness_id: harness,
    availability: "available",
    verification: "passed",
    verification_source: "local_store",
    detail: "current executable",
    last_verified_at: new Date().toISOString(),
  };
  const probe = vi.fn(async () => status);
  const adapter = retainAccountProbeObservations({
    ...createFakeHarness("fake-success"),
    ...(kind === "profile"
      ? { probeCredentialProfile: probe }
      : { probeCredentialAccount: async () => ({ status: await probe(), identity: null }) }),
  });
  return {
    profile,
    status,
    probe,
    run: () =>
      kind === "profile"
        ? adapter.probeCredentialProfile!(profile)
        : adapter.probeCredentialAccount!(profile),
    display: () => displayAccountObservation(profile, adapter),
  };
}

describe.each(["profile", "account"] as const)("retained %s probes", (kind) => {
  it.each([true, false])(
    "rejects a pre-maintenance receipt for this harness (newer read: %s)",
    async (newerRead) => {
      const f = fixture(kind);
      let release!: (value: CredentialProfileStatus) => void;
      f.probe.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
      const pending = f.run();
      accountObservations.invalidateHarness(f.profile.harness_id);
      if (newerRead) expect((await f.display()).status.detail).toBe("current executable");
      release({ ...f.status, verification: "failed", detail: "old executable" });
      await pending;
      expect((await f.display()).status.detail).toBe("current executable");
      expect((await f.display()).status.verification).toBe("passed");
      expect(f.probe).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves unrelated cached and in-flight observations, then retains new affected probes", async () => {
    const affected = fixture(kind);
    const cached = fixture(kind, "other-harness", "cached");
    const inFlight = fixture(kind, "other-harness", "in-flight");
    await cached.display();
    let release!: (value: CredentialProfileStatus) => void;
    inFlight.probe.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const pending = inFlight.run();
    accountObservations.invalidateHarness(affected.profile.harness_id);
    release(inFlight.status);
    await pending;
    await affected.run();
    expect((await affected.display()).status).toEqual(affected.status);
    expect((await cached.display()).status).toEqual(cached.status);
    expect((await inFlight.display()).status).toEqual(inFlight.status);
    for (const f of [affected, cached, inFlight]) expect(f.probe).toHaveBeenCalledTimes(1);
  });

  it("global invalidation still rejects late receipts from every harness", async () => {
    const fixtures = [fixture(kind), fixture(kind, "other-harness")];
    const pending = fixtures.map((f) => {
      let release!: (value: CredentialProfileStatus) => void;
      f.probe.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
      const result = f.run();
      return { result, release };
    });
    accountObservations.invalidate();
    for (const [index, item] of pending.entries()) {
      item.release({
        ...fixtures[index]!.status,
        verification: "failed",
        detail: "old executable",
      });
      await item.result;
    }
    for (const f of fixtures) {
      expect((await f.display()).status.detail).toBe("current executable");
      expect(f.probe).toHaveBeenCalledTimes(2);
    }
  });
});
