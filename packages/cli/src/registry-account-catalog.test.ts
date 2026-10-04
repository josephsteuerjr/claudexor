import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter, HarnessModelSpec } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import { CredentialProfile, GlobalConfig, type HarnessModel } from "@claudexor/schema";
import { accountObservations } from "./account-observations.js";

beforeEach(() => accountObservations.invalidate());

import { harnessAccountModels } from "./registry.js";

function fixture() {
  const harnessId = "fake-success";
  const profiles = ["a", "b"].map((id) =>
    CredentialProfile.parse({
      profile_id: id,
      harness_id: harnessId,
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: `/catalog-fixture/${id}`,
    }),
  );
  const config = GlobalConfig.parse({ credential_profiles: profiles });
  const models = vi.fn(async (spec?: HarnessModelSpec): Promise<HarnessModel[]> => [
    {
      id: `model-${spec?.credentialProfile?.profile_id}`,
      label: null,
      context_window: spec?.credentialProfile?.profile_id === "b" ? 1000000 : 100000,
      routes: null,
    },
  ]);
  const adapter: HarnessAdapter = {
    ...createFakeHarness(harnessId),
    models,
    probeCredentialProfile: async (profile) => ({
      profile_id: profile.profile_id,
      harness_id: harnessId,
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      last_verified_at: null,
    }),
  };
  const input = {
    harnessId,
    cwd: "/catalog-fixture",
    config,
    quota: { snapshots: [], absences: [] },
    registry: new Map([[harnessId, adapter]]),
  };
  return { input, models, adapter };
}

describe("account-scoped harness model inventory", () => {
  it("preserves each account's model facts, scopes every query, and never invents a fresh timestamp", async () => {
    const f = fixture();
    const response = await harnessAccountModels(f.input);
    expect(response.partial).toBe(false);
    expect(response.accounts.map((row) => row.catalog?.models)).toEqual([
      [{ id: "model-a", label: null, context_window: 100000, routes: null }],
      [{ id: "model-b", label: null, context_window: 1000000, routes: null }],
    ]);
    expect(
      response.accounts.every(
        (row) => row.catalog?.observedAt === null && row.catalog.provenance === "adapter_models",
      ),
    ).toBe(true);
    expect(f.models.mock.calls.map(([spec]) => spec?.credentialProfile?.profile_id)).toEqual([
      "a",
      "b",
    ]);
    f.models.mockClear();
    const pinned = await harnessAccountModels({ ...f.input, credentialProfileId: "b" });
    expect(pinned.accounts.map((row) => row.credentialProfileId)).toEqual(["b"]);
    expect(f.models).not.toHaveBeenCalled();
    await expect(
      harnessAccountModels({ ...f.input, credentialProfileId: "absent" }),
    ).rejects.toMatchObject({ code: "model_account_unavailable" });
  });

  it("keeps a network failure local to its row and never calls it missing authentication", async () => {
    const f = fixture();
    const original = f.models.getMockImplementation()!;
    f.models.mockImplementation(async (spec) => {
      if (spec?.credentialProfile?.profile_id === "a") throw new Error("transport timeout");
      return original(spec);
    });
    const response = await harnessAccountModels(f.input);
    expect(response.partial).toBe(true);
    expect(response.accounts[0]).toMatchObject({
      availability: "unknown",
      catalog: null,
      problem: { code: "model_catalog_unavailable" },
    });
    expect(response.accounts[1]).toMatchObject({
      availability: "available",
      problem: null,
      catalog: { models: [{ id: "model-b" }] },
    });
  });

  it("reports an account whose probe answered only hint rows as manifest truth, and a live answer as api", async () => {
    // A total producer (claude) answers the frozen hints when it could not read
    // the vendor; that row must not read as a live enumeration of this account.
    const f = fixture();
    const manifest = await f.adapter.discover();
    f.models.mockImplementation(async (spec) =>
      spec?.credentialProfile?.profile_id === "a"
        ? [{ id: "hint-only", label: null, context_window: null, routes: null, origin: "hint" }]
        : [
            { id: "live-b", label: null, context_window: null, routes: null, origin: "live" },
            { id: "hint-b", label: null, context_window: null, routes: null, origin: "hint" },
          ],
    );
    const response = await harnessAccountModels(f.input);
    expect(response.partial).toBe(false);
    expect(response.accounts[0]?.catalog).toMatchObject({
      source: "manifest",
      verifiedAgainst: manifest.capabilities.known_models_verified_against ?? null,
      provenance: "manifest",
      models: [{ id: "hint-only", origin: "hint" }],
    });
    // One live row is a vendor answer; the hint rows beside it do not demote it.
    expect(response.accounts[1]?.catalog).toMatchObject({
      source: "api",
      verifiedAgainst: null,
      provenance: "adapter_models",
    });
  });

  it("does not promote a swallowed models error into a confirmed empty inventory", async () => {
    const f = fixture();
    f.models.mockResolvedValue([]);
    const response = await harnessAccountModels(f.input);
    expect(response.partial).toBe(true);
    expect(
      response.accounts.every(
        (row) =>
          row.catalog === null &&
          row.availability === "unknown" &&
          row.problem?.code === "model_catalog_unavailable",
      ),
    ).toBe(true);
  });

  it("retains an unavailable row with honest manifest fallback without querying its credentials", async () => {
    const f = fixture();
    const manifest = await f.adapter.discover();
    manifest.capabilities.known_models = [
      { id: "subscription-hint", routes: ["local_session"] },
      { id: "paid-hint", routes: ["api_key"] },
    ];
    manifest.capabilities.known_models_verified_against = "fixture-1";
    f.adapter.discover = async () => manifest;
    f.adapter.probeCredentialProfile = async (profile) => ({
      profile_id: profile.profile_id,
      harness_id: profile.harness_id,
      availability: "unavailable",
      verification: "failed",
      verification_source: "local_store",
      last_verified_at: null,
    });
    const response = await harnessAccountModels(f.input);
    expect(response.accounts[0]).toMatchObject({
      availability: "unavailable",
      problem: { code: "auth_unavailable" },
      catalog: {
        source: "manifest",
        observedAt: null,
        provenance: "manifest",
        verifiedAgainst: "fixture-1",
        models: [{ id: "subscription-hint" }],
      },
    });
    expect(f.models).not.toHaveBeenCalled();
  });

  it("filters account rows by the requested credential route and rejects a conflicting pin", async () => {
    const f = fixture();
    f.input.config.credential_profiles[1] = CredentialProfile.parse({
      ...f.input.config.credential_profiles[1],
      credential_kind: "api_key",
      isolation_locator: null,
      secret_ref: "openai:api",
    });
    const api = await harnessAccountModels({ ...f.input, route: "api_key" });
    expect(api.accounts.map((row) => row.credentialProfileId)).toEqual(["b"]);
    expect(f.models.mock.calls.map(([spec]) => spec?.credentialProfile?.profile_id)).toEqual(["b"]);
    f.models.mockClear();
    const local = await harnessAccountModels({ ...f.input, route: "local_session" });
    expect(local.accounts.map((row) => row.credentialProfileId)).toEqual(["a"]);
    expect(f.models.mock.calls.map(([spec]) => spec?.credentialProfile?.profile_id)).toEqual(["a"]);
    await expect(
      harnessAccountModels({ ...f.input, route: "local_session", credentialProfileId: "b" }),
    ).rejects.toMatchObject({ code: "model_account_unavailable", status: 409 });
  });
});

it("uses API-key manifest provenance while native accounts retain their own live inventory", async () => {
  const f = fixture();
  const manifest = await f.adapter.discover();
  manifest.capabilities.model_inventory_routes = ["local_session"];
  manifest.capabilities.known_models = [
    { id: "native-hint", routes: ["local_session"] },
    { id: "api-hint", routes: ["api_key"] },
  ];
  manifest.capabilities.known_models_verified_against = "fixture-2";
  const discover = vi.fn(async () => manifest);
  f.adapter.discover = discover;
  f.input.config.credential_profiles[1] = CredentialProfile.parse({
    ...f.input.config.credential_profiles[1],
    credential_kind: "api_key",
    isolation_locator: null,
    secret_ref: "openai:api",
  });
  const response = await harnessAccountModels(f.input);
  expect(response.partial).toBe(false);
  expect(discover).toHaveBeenCalledTimes(1);
  expect(response.accounts[0].catalog).toMatchObject({
    source: "api",
    provenance: "adapter_models",
    models: [{ id: "model-a" }],
  });
  expect(response.accounts[1].catalog).toMatchObject({
    source: "manifest",
    provenance: "manifest",
    observedAt: null,
    verifiedAgainst: "fixture-2",
    models: [{ id: "api-hint", routes: ["api_key"] }],
  });
  expect(f.models).toHaveBeenCalledTimes(1);
  expect(f.models.mock.calls[0][0]?.credentialProfile?.profile_id).toBe("a");
  f.models.mockResolvedValue([]);
  accountObservations.invalidate(); // Explicit refresh requests new evidence.
  const failed = await harnessAccountModels(f.input);
  expect(failed.accounts[0]).toMatchObject({
    catalog: null,
    problem: { code: "model_catalog_unavailable" },
  });
  expect(failed.accounts[1].catalog?.source).toBe("manifest");
});
