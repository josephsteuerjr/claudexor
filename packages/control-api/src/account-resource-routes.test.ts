import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonControlApiServer, type DaemonFacadeClient } from "./daemon-server.js";
import { parseCredentialProfilesSnapshotQuery } from "./catalog-query.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";
const servers: DaemonControlApiServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});
const raw = { snapshots: [], absences: [], refreshed_at: null };
describe("resource wire negotiation and direct reset route", () => {
  it("requires snapshot for the rich atomic Accounts representation", () => {
    expect(() =>
      parseCredentialProfilesSnapshotQuery(
        new URL("http://fixture/v2/credential-profiles?view=resources"),
      ),
    ).toThrow("snapshot=true");
    expect(
      parseCredentialProfilesSnapshotQuery(
        new URL("http://fixture/v2/credential-profiles?snapshot=true&view=resources"),
      ).input,
    ).toEqual({ snapshot: true, view: "resources" });
  });
  it("advertises the opt-in query and key-required reset operation", () => {
    const catalog = OPERATION_CATALOG;
    expect(catalog.operations.find((o) => o.id === "get:quota")?.parameters).toContainEqual(
      expect.objectContaining({ name: "view", enum: ["resources"] }),
    );
    expect(catalog.operations.find((o) => o.id === "post:account-resets")).toMatchObject({
      idempotency: "key_required",
      completion: "immediate",
    });
  });
  it("serves legacy/rich quota and reset even while inference enqueue is unavailable", async () => {
    const enqueue = vi.fn(async () => {
      throw new Error("inference capacity saturated");
    });
    const request = {
      target: { harness: "codex", profile_id: "codex-default" },
      offer_id: "codex_granted",
    };
    const receipt = {
      id: "account-reset-test",
      request,
      state: "completed",
      created_at: "2026-10-09T12:00:00Z",
      completed_at: "2026-10-09T12:00:01Z",
      outcome: "reset",
      detail: null,
      readback: { state: "failed", attempted_at: "2026-10-09T12:00:01Z", detail: "offline" },
      resources: { ...raw, resources: [] },
    };
    const createAccountReset = vi.fn(async () => receipt);
    const refreshQuota = vi.fn(async (input) => (input?.view ? { ...raw, resources: [] } : raw));
    const server = new DaemonControlApiServer({
      token: "fixture",
      daemon: { enqueue } as unknown as DaemonFacadeClient,
      services: {
        quota: async (input) => (input?.view ? { ...raw, resources: [] } : raw),
        refreshQuota,
        createAccountReset,
        accountReset: async () => receipt,
      },
    });
    servers.push(server);
    const { host, port } = await server.start();
    const call = (path: string, body?: unknown, key?: string) =>
      fetch(`http://${host}:${port}/v2${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: "Bearer fixture",
          "X-Claudexor-Protocol-Major": "3",
          ...(key ? { "Idempotency-Key": key } : {}),
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    expect(await (await call("/quota")).json()).toEqual(raw);
    expect(await (await call("/quota?view=resources")).json()).toEqual({ ...raw, resources: [] });
    expect((await call("/quota?view=resources", { target: request.target })).status).toBe(200);
    expect(refreshQuota).toHaveBeenLastCalledWith({ target: request.target, view: "resources" });
    const reset = await call("/account-resets", request, "same-key");
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual(receipt);
    expect(createAccountReset).toHaveBeenCalledWith({
      request,
      idempotencyKey: "same-key",
      clientId: "control-api",
    });
    expect(await (await call("/account-resets/account-reset-test")).json()).toEqual(receipt);
    expect((await call("/account-resets", request)).status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
