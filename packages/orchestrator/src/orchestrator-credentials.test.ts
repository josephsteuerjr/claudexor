import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import type { CredentialUnusableObservation, HarnessRunSpec } from "@claudexor/schema";
import {
  OrchestratorCredentials,
  type CredentialResolutionHost,
} from "./orchestrator-credentials.js";
import {
  preProgressRefusalSubject,
  type PreProgressRefusalMemory,
} from "./pre-progress-refusal.js";
import type { TransientFailureObservation } from "./transientClassify.js";
import { CredentialUnusableLedger } from "../../daemon/src/credential-unusable-ledger.js";
import { createCredentialExecutionObserver } from "./credential-execution.js";
import type { CredentialExecutionSubject } from "@claudexor/core";

// #363: the A7 differential verdict about a try's CURRENT subject is recorded
// only while the credential that try bound is still the account's current one.

const authRefusal: TransientFailureObservation = {
  kind: "unknown",
  category: "auth_failed",
  retryable: false,
  retryDelayMs: null,
  httpStatus: null,
  signal: null,
  adapterCode: "auth_required",
};

function fixture() {
  const recorded: CredentialUnusableObservation[] = [];
  let generation = 0;
  const memory: PreProgressRefusalMemory = {
    live: () => [],
    generation: () => generation,
    record: () => {},
    clear: () => {},
  };
  const host = {
    quotaSnapshots: () => [],
    quotaAbsences: () => [],
    credentialUnusable: () => [],
    recordCredentialUnusable: (obs: CredentialUnusableObservation) => void recorded.push(obs),
    preProgressRefusals: () => memory,
  } as unknown as CredentialResolutionHost;
  const spec = {
    model_hint: "m",
    credential_profile: {
      profile_id: "a",
      harness_id: "cursor",
      display_name: "a",
      credential_kind: "config_dir_login",
      isolation_locator: "/tmp/cursor-a",
      secret_ref: null,
      enabled: true,
      created_at: null,
    },
  } as unknown as HarnessRunSpec;
  const credentials = new OrchestratorCredentials(host);
  const adapter = { id: "cursor" } as HarnessAdapter;
  return {
    recorded,
    change: (next: number) => (generation = next),
    verdict: async (bindAt: number) => {
      generation = bindAt;
      const refusal = preProgressRefusalSubject(memory, "cursor", spec);
      return (subjectAfter: number) => {
        generation = subjectAfter;
        return credentials
          .rotationObservations(adapter, spec, [authRefusal], refusal)
          .probeCurrentSubject();
      };
    },
  };
}

describe("OrchestratorCredentials differential verdict fence (#363)", () => {
  it("does not record an asynchronous local probe after native or API credential change", async () => {
    for (const api of [false, true]) {
      const ledger = new CredentialUnusableLedger();
      const spec = {
        model_hint: "m",
        auth_preference: api ? "api_key" : "subscription",
        credential_profile: {
          profile_id: "a",
          harness_id: "claude",
          credential_kind: api ? "api_key" : "config_dir_login",
        },
        extra: {},
      } as unknown as HarnessRunSpec;
      let complete!: (value: unknown) => void;
      const result = new Promise((resolve) => {
        complete = resolve;
      });
      const host = {
        quotaSnapshots: () => [],
        quotaAbsences: () => [],
        credentialUnusable: () => ledger.live(),
        credentialEvidence: () => ledger,
        credentialObserverFactory: () => (subject: CredentialExecutionSubject) =>
          createCredentialExecutionObserver(ledger, ledger.bind(subject)),
        recordCredentialUnusable: () => {
          throw new Error("unbound recording");
        },
      } as unknown as CredentialResolutionHost;
      const adapter = {
        id: "claude",
        probeCredentialProfile: () => result,
      } as unknown as HarnessAdapter;
      const probe = new OrchestratorCredentials(host)
        .rotationObservations(adapter, spec, [], null)
        .probeCurrentSubject();
      ledger.clearSubject("claude", "a");
      complete({
        harness_id: "claude",
        profile_id: "a",
        availability: "available",
        verification: "failed",
        verification_source: "local_store",
        last_verified_at: null,
      });
      expect(await probe).toMatchObject({ code: "verification_failed" });
      expect(ledger.live()).toEqual([]);
    }
  });
  it("fences the legacy default subject and preserves its actual quota route", async () => {
    const ledger = new CredentialUnusableLedger();
    const host = {
      quotaSnapshots: () => [],
      quotaAbsences: () => [
        {
          subject: {
            harness: "claude",
            subject_id: null,
            credential_route: "vendor_native",
            plan_label: null,
          },
          reason: "auth_revoked",
          detail: "vendor rejection",
          observed_at: new Date().toISOString(),
        },
      ],
      credentialUnusable: () => ledger.live(),
      credentialEvidence: () => ledger,
      credentialObserverFactory: () => (subject: CredentialExecutionSubject) =>
        createCredentialExecutionObserver(ledger, ledger.bind(subject)),
    } as unknown as CredentialResolutionHost;
    const credentials = new OrchestratorCredentials(host);
    const spec = {
      model_hint: "m",
      credential_profile: null,
      auth_preference: "subscription",
      extra: {},
    } as unknown as HarnessRunSpec;
    const adapter = { id: "claude" } as HarnessAdapter;
    const late = credentials.rotationObservations(adapter, spec, [], null).probeCurrentSubject();
    ledger.clearDefaultSubjects();
    expect(await late).toMatchObject({ profile_id: null, code: "auth_revoked" });
    expect(ledger.live()).toEqual([]);
    const api = { ...spec, auth_preference: "api_key" } as HarnessRunSpec;
    expect(
      await credentials.rotationObservations(adapter, api, [], null).probeCurrentSubject(),
    ).toBeNull();
  });
  it("records the verdict while the bound credential is current", async () => {
    const f = fixture();
    const probe = await f.verdict(3);
    expect(await probe(3)).toMatchObject({ code: "auth_revoked", profile_id: "a" });
    expect(f.recorded).toHaveLength(1);
  });

  it.each([
    ["a credential change since the try spawned", 4],
    ["an open login window (generation is no number)", Number.NaN],
  ])("does not record it after %s", async (_label, after) => {
    const f = fixture();
    const probe = await f.verdict(3);
    // The rotation decision still sees the verdict; only the memory refuses it.
    expect(await probe(after)).toMatchObject({ code: "auth_revoked" });
    expect(f.recorded).toEqual([]);
  });
});
