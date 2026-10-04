import { describe, expect, it } from "vitest";
import type { CredentialUnusableObservation, HarnessEvent } from "@claudexor/schema";
import { CredentialUnusableLedger } from "./credential-unusable-ledger.js";

const T0 = Date.parse("2026-08-18T10:00:00.000Z");
const subject = {
  harnessId: "claude",
  profileId: "work",
  route: "vendor_native" as const,
  requestedModel: null,
};

function ledgerAt(): { ledger: CredentialUnusableLedger; clock: { now: number } } {
  const clock = { now: T0 };
  return { ledger: new CredentialUnusableLedger(() => new Date(clock.now)), clock };
}

function obs(over: Partial<CredentialUnusableObservation>): CredentialUnusableObservation {
  return {
    harness_id: "claude",
    profile_id: "work",
    model: null,
    code: "auth_revoked",
    source: "vendor_poller",
    detail: null,
    observed_at: new Date(T0).toISOString(),
    expires_at: new Date(T0 + 60 * 60_000).toISOString(),
    ...over,
  };
}

function usage(over: Partial<HarnessEvent> = {}): HarnessEvent {
  return {
    type: "usage",
    session_id: "se-1",
    ts: new Date(T0).toISOString(),
    usage: { input_tokens: 10, output_tokens: 5 },
    credential_profile_id: "work",
    ...over,
  } as HarnessEvent;
}

function honorUsage(
  ledger: CredentialUnusableLedger,
  harnessId: string,
  event: HarnessEvent,
): void {
  const binding = ledger.bind({
    harnessId,
    profileId: event.credential_profile_id ?? null,
    route: event.credential_route ?? null,
    requestedModel: event.observed_model ?? null,
  });
  if (
    event.type === "usage" &&
    ((event.usage?.input_tokens ?? 0) > 0 || (event.usage?.output_tokens ?? 0) > 0)
  )
    ledger.honorBound(binding, event.observed_model ?? null);
}

describe("CredentialUnusableLedger (A7 bounded typed evidence)", () => {
  it("records a typed observation and serves it while live", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({}));
    expect(ledger.live()).toHaveLength(1);
    expect(ledger.live()[0]).toMatchObject({ code: "auth_revoked", profile_id: "work" });
  });

  it("rejects a malformed observation loudly (schema-parsed, never silently stored)", () => {
    const { ledger } = ledgerAt();
    expect(() =>
      ledger.record({ ...obs({}), code: "made_up" } as unknown as CredentialUnusableObservation),
    ).toThrow();
  });

  it("an EXPIRED observation is never served (clearing contract: self-expiry)", () => {
    const { ledger, clock } = ledgerAt();
    ledger.record(obs({}));
    clock.now = T0 + 2 * 60 * 60_000;
    expect(ledger.live()).toHaveLength(0);
  });

  it("clamps every write to the 24h TTL bound", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({ expires_at: new Date(T0 + 7 * 24 * 60 * 60_000).toISOString() }));
    const row = ledger.live()[0]!;
    expect(Date.parse(row.expires_at) - T0).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  it("a served model response for the SAME subject clears its credential-wide rows (clearing contract: success)", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({}));
    ledger.record(obs({ profile_id: "other" }));
    honorUsage(ledger, "claude", usage());
    expect(ledger.live().map((o) => o.profile_id)).toEqual(["other"]);
  });

  it("a ZERO-token usage event proves nothing and clears nothing", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({}));
    honorUsage(ledger, "claude", usage({ usage: { input_tokens: 0, output_tokens: 0 } }));
    expect(ledger.live()).toHaveLength(1);
  });

  it("a MODEL-SCOPED row clears only on an exactly-matching observed model", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({ code: "capability_refused", model: "opus" }));
    honorUsage(ledger, "claude", usage({ observed_model: "sonnet" }));
    expect(ledger.live()).toHaveLength(1);
    honorUsage(ledger, "claude", usage({ observed_model: "opus" }));
    expect(ledger.live()).toHaveLength(0);
  });

  it("success on ANOTHER subject never clears this one", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({}));
    honorUsage(ledger, "claude", usage({ credential_profile_id: "other" }));
    honorUsage(ledger, "codex", usage());
    expect(ledger.live()).toHaveLength(1);
  });

  it("a credential-generation change voids every verdict (clearing contract: re-login)", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({}));
    ledger.record(obs({ profile_id: "other" }));
    ledger.noteCredentialChange();
    expect(ledger.live()).toHaveLength(0);
  });

  it("stays bounded: the earliest-expiring row is evicted, never the newest evidence refused", () => {
    const { ledger } = ledgerAt();
    for (let i = 0; i < 64; i += 1) {
      ledger.record(
        obs({
          profile_id: `p${i}`,
          expires_at: new Date(T0 + (i + 1) * 60_000).toISOString(),
        }),
      );
    }
    ledger.record(
      obs({ profile_id: "newest", expires_at: new Date(T0 + 90 * 60_000).toISOString() }),
    );
    const ids = ledger.live().map((o) => o.profile_id);
    expect(ids).toHaveLength(64);
    expect(ids).toContain("newest");
    expect(ids).not.toContain("p0");
  });

  it("newest-wins per (subject, model): re-recording replaces, never duplicates", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({ code: "auth_revoked" }));
    ledger.record(obs({ code: "verification_failed", source: "local_probe" }));
    expect(ledger.live()).toHaveLength(1);
    expect(ledger.live()[0]?.code).toBe("verification_failed");
  });

  it("records no verdict while a login window of that harness is open (#363)", () => {
    let open = true;
    const ledger = new CredentialUnusableLedger(
      () => new Date(T0),
      (harness) => open && harness === "claude",
    );
    ledger.record(obs({}));
    ledger.record(obs({ harness_id: "codex" }));
    expect(ledger.live().map((o) => o.harness_id)).toEqual(["codex"]);
    open = false;
    ledger.record(obs({}));
    expect(
      ledger
        .live()
        .map((o) => o.harness_id)
        .sort(),
    ).toEqual(["claude", "codex"]);
  });

  it("an expired hidden witness cannot retain its old dispatch boundary", () => {
    const { ledger, clock } = ledgerAt();
    const A = ledger.bind(subject),
      D = ledger.bind(subject),
      B = ledger.bind(subject),
      C = ledger.bind(subject);
    ledger.recordBound(B, obs({ expires_at: new Date(T0 + 1000).toISOString() }));
    clock.now = T0 + 100;
    ledger.honorBound(C, null);
    expect(ledger.live()).toEqual([]);
    clock.now = T0 + 2000;
    ledger.recordBound(A, obs({ observed_at: new Date(clock.now).toISOString() }));
    expect(ledger.live()).toHaveLength(1);
    clock.now = T0 + 2100;
    ledger.honorBound(D, null);
    expect(ledger.live()).toEqual([]);
    expect(ledger.honored()).toMatchObject([{ observed_at: new Date(clock.now).toISOString() }]);
  });

  it("positive contacts self-expire without extending their original contact time", () => {
    const { ledger, clock } = ledgerAt();
    ledger.honorBound(ledger.bind(subject), null);
    expect(ledger.honored()).toMatchObject([{ observed_at: new Date(T0).toISOString() }]);
    clock.now = T0 + 24 * 60 * 60_000;
    expect(ledger.honored()).toEqual([]);
  });

  it("default generation clearing removes hidden witnesses and all real points on both routes", () => {
    const { ledger, clock } = ledgerAt();
    const bindings = ["vendor_native", "managed_api_key"] as const;
    const old = bindings.map((route) => ledger.bind({ ...subject, profileId: null, route }));
    for (const binding of old)
      ledger.recordBound(
        binding,
        obs({ profile_id: null, credential_route: binding.subject.route! }),
      );
    clock.now = T0 + 100;
    for (const route of bindings)
      ledger.honorBound(ledger.bind({ ...subject, profileId: null, route }), null);
    ledger.honorBound(ledger.bind(subject), null);
    expect(ledger.live()).toEqual([]);
    expect(ledger.honored()).toHaveLength(3);
    ledger.clearDefaultSubjects();
    for (const binding of old) {
      ledger.honorBound(binding, null);
      ledger.recordBound(
        binding,
        obs({ profile_id: null, credential_route: binding.subject.route! }),
      );
    }
    expect(ledger.live()).toEqual([]);
    expect(ledger.honored().map((point) => point.profile_id)).toEqual(["work"]);
    ledger.noteCredentialChange();
    expect(ledger.honored()).toEqual([]);
  });

  it("bounds actual incomparable positive entries even when they share one key", () => {
    const { ledger, clock } = ledgerAt();
    const bindings = Array.from({ length: 70 }, () => ledger.bind(subject));
    for (const [index, binding] of bindings.entries()) {
      clock.now = T0 + 1000 + index;
      ledger.honorBound(binding, null, new Date(T0 + 500 - index).toISOString());
    }
    const contacts = ledger.honored().map((point) => point.observed_at);
    expect(contacts).toHaveLength(64);
    expect(contacts).not.toContain(new Date(T0 + 500).toISOString());
    expect(contacts).toContain(new Date(T0 + 431).toISOString());
  });

  it("monotonic success replaces dominated contacts rather than accumulating history", () => {
    const { ledger, clock } = ledgerAt();
    for (let index = 0; index < 70; index++) {
      clock.now = T0 + index;
      ledger.honorBound(ledger.bind(subject), "model-a");
    }
    expect(ledger.honored()).toMatchObject([
      { model: null, observed_at: new Date(clock.now).toISOString() },
      { model: "model-a", observed_at: new Date(clock.now).toISOString() },
    ]);
    expect(ledger.honored()).toHaveLength(2);
  });

  it("recovery points retain route and actual-model scope", () => {
    const { ledger, clock } = ledgerAt();
    const api = { ...subject, route: "managed_api_key" as const };
    ledger.recordBound(ledger.bind(api), obs({ credential_route: "managed_api_key" }));
    clock.now = T0 + 100;
    ledger.recordBound(
      ledger.bind(subject),
      obs({
        credential_route: "vendor_native",
        code: "capability_refused",
        model: "model-a",
        observed_at: new Date(clock.now).toISOString(),
      }),
    );
    clock.now = T0 + 200;
    ledger.honorBound(ledger.bind(subject), "model-b");
    expect(ledger.live()).toHaveLength(2);
    clock.now = T0 + 300;
    ledger.honorBound(ledger.bind(subject), null);
    expect(ledger.live()).toHaveLength(2);
    clock.now = T0 + 400;
    ledger.honorBound(ledger.bind(subject), "model-a");
    expect(ledger.live()).toMatchObject([{ credential_route: "managed_api_key" }]);
    clock.now = T0 + 500;
    ledger.honorBound(ledger.bind(api), null);
    expect(ledger.live()).toEqual([]);
  });
});
