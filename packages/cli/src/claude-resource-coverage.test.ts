import { describe, expect, it, vi } from "vitest";
import { observeClaudeAccountResources } from "./claude-resource-source.js";
import { mergeResources } from "../../daemon/src/quota-resources.js";

const before = new Date("2026-10-09T10:00:00Z");
const after = new Date("2026-10-09T11:00:00Z");
const grant = { eligible: true, grants: [{ id: "grant", resets_left: 2, usable_now: true }] };
const refill = { eligible: true, arm: "reset", available: true };
const target = { harness: "claude", profile_id: "fixture" };
async function observe(
  usage: unknown,
  options: { foreground?: boolean; refill?: unknown; reject?: boolean; at?: Date } = {},
) {
  const fetchRefill = vi.fn(async () => {
    if (options.reject) throw new Error("fixture offline");
    return options.refill;
  });
  const observation = await observeClaudeAccountResources({
    usage,
    profileId: target.profile_id,
    configDir: "/fixture",
    accessToken: "fixture-only",
    requestStartedAt: options.at ?? after,
    deps: { fetchUsage: async () => usage, fetchRefill },
    cycle: { foreground: options.foreground ?? false, target },
    now: () => options.at ?? after,
    onRateLimited: vi.fn(),
    readNativeVersion: async () => null,
  });
  return { observation, fetchRefill };
}
async function initial() {
  return mergeResources(
    undefined,
    (
      await observe(
        { cedar_ember: grant },
        {
          foreground: true,
          refill: { juniper_tide: refill },
          at: before,
        },
      )
    ).observation,
  );
}

describe("Claude reset program read authority", () => {
  it("background null removes the resolved grant but retains the unread refill without a failed-check label", async () => {
    const { observation, fetchRefill } = await observe({ cedar_ember: null, juniper_tide: null });
    expect(fetchRefill).not.toHaveBeenCalled();
    expect(observation).toMatchObject({
      resets_resolved_ids: ["claude_granted"],
      resets: { value: [], freshness: "fresh" },
    });
    expect(mergeResources(await initial(), observation).resets).toMatchObject({
      value: [{ id: "claude_session_refill" }],
      observed_at: before.toISOString(),
      last_attempt_at: after.toISOString(),
      freshness: "stale",
      last_error: null,
    });
  });

  it("never takes the refill program from the ordinary usage body", async () => {
    const { observation } = await observe({ cedar_ember: grant, juniper_tide: refill });
    expect(observation.resets?.value?.map((offer) => offer.id)).toEqual(["claude_granted"]);
    expect(observation).toMatchObject({ resets_resolved_ids: ["claude_granted"] });
  });

  it("authoritative foreground null drops a refill even when usage still reports it", async () => {
    const { observation, fetchRefill } = await observe(
      { cedar_ember: grant, juniper_tide: refill },
      {
        foreground: true,
        refill: { juniper_tide: null },
      },
    );
    expect(fetchRefill).toHaveBeenCalledOnce();
    expect(observation).toMatchObject({
      resets_resolved_ids: ["claude_granted", "claude_session_refill"],
    });
    const merged = mergeResources(await initial(), observation);
    expect(merged.resets.value?.map((offer) => offer.id)).toEqual(["claude_granted"]);
    expect(merged.resets).toMatchObject({
      observed_at: after.toISOString(),
      freshness: "fresh",
      last_error: null,
    });
  });

  it("resolves both explicit null programs as a fresh empty inventory", async () => {
    const { observation } = await observe(
      { cedar_ember: null },
      { foreground: true, refill: { juniper_tide: null } },
    );
    expect(mergeResources(await initial(), observation).resets).toMatchObject({
      value: [],
      observed_at: after.toISOString(),
      freshness: "fresh",
      last_error: null,
    });
  });

  it("retains a refill after its supplemental read failed, even if usage contains another copy", async () => {
    const { observation } = await observe(
      { cedar_ember: grant, juniper_tide: { ...refill, available: false } },
      { foreground: true, reject: true },
    );
    expect(observation).toMatchObject({ resets_resolved_ids: ["claude_granted"] });
    const merged = mergeResources(await initial(), observation);
    expect(merged.resets).toMatchObject({
      observed_at: before.toISOString(),
      freshness: "stale",
      last_error: "refill_read_failed",
    });
    expect(
      merged.resets.value?.find((offer) => offer.id === "claude_session_refill")?.usable_now,
    ).toBe(true);
  });

  it.each(
    [
      undefined,
      null,
      [],
      "bad",
      {},
      { unrelated: true },
      { juniper_tide: {} },
      { juniper_tide: "bad" },
      { juniper_tide: { available: "bad" } },
    ].map((body) => ({ body })),
  )(
    "does not resolve absent refill from malformed or fieldless successful body $body",
    async ({ body }) => {
      const { observation } = await observe(
        { cedar_ember: grant, juniper_tide: null },
        { foreground: true, refill: body },
      );
      expect(observation).toMatchObject({ resets_resolved_ids: ["claude_granted"] });
      const merged = mergeResources(await initial(), observation);
      expect(
        merged.resets.value?.find((offer) => offer.id === "claude_session_refill")?.usable_now,
      ).toBe(true);
      expect(merged.resets).toMatchObject({
        observed_at: before.toISOString(),
        freshness: "stale",
        last_error: null,
      });
    },
  );

  it.each(
    [
      undefined,
      null,
      [],
      "bad",
      {},
      { unrelated: true },
      { cedar_ember: {} },
      { cedar_ember: "bad" },
      { cedar_ember: { grants: "bad" } },
    ].map((body) => ({ body })),
  )(
    "does not resolve absent grant from malformed or fieldless successful body $body",
    async ({ body }) => {
      const { observation } = await observe(body);
      expect(observation).toMatchObject({ resets_resolved_ids: [] });
      const merged = mergeResources(await initial(), observation);
      expect(merged.resets.value?.map((offer) => offer.id)).toEqual([
        "claude_granted",
        "claude_session_refill",
      ]);
      expect(merged.resets).toMatchObject({
        observed_at: before.toISOString(),
        freshness: "stale",
      });
    },
  );

  it("keeps a previously grant-only background inventory fresh", async () => {
    const first = (await observe({ cedar_ember: grant }, { at: before })).observation;
    const second = (await observe({ cedar_ember: grant, juniper_tide: null })).observation;
    const merged = mergeResources(mergeResources(undefined, first), second);
    expect(merged.resets.value?.map((offer) => offer.id)).toEqual(["claude_granted"]);
    expect(merged.resets).toMatchObject({
      observed_at: after.toISOString(),
      freshness: "fresh",
      last_error: null,
    });
  });
});
