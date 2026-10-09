import { describe, expect, it, vi } from "vitest";
import { parseCodexAccountResources, parseCodexRateLimitsResponse } from "@claudexor/harness-codex";
import { parseClaudeAccountResources, parseClaudePrepaid } from "./claude-account-resources.js";
import { nativeResetOutcome } from "./account-reset-services.js";
import { claudeResourceRequest } from "./claude-resource-transport.js";
import { legacyQuotaResponse, accountResourcesResponse } from "./quota-services.js";
import {
  AccountResourceSnapshot,
  emptyResourceFacet,
  ControlQuotaResponse,
  ControlAccountResourcesResponse,
  quotaSnapshotAvailability,
} from "@claudexor/schema";

const at = new Date("2026-10-09T12:00:00Z");
describe("provider account resource codecs", () => {
  it.each([null, "0", "12.3400"])(
    "preserves Codex amount %s and authoritative count with capped details",
    (amount) => {
      const payload = {
        rateLimits: {
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2000000000 },
          credits: { balance: amount, hasCredits: amount !== "0", unlimited: false },
          individualLimit: { used: "12.3400", limit: "100.0000", resetsAt: 2000000000 },
          spendControlReached: false,
        },
        rateLimitResetCredits: {
          availableCount: 5,
          credits: [
            {
              id: "credit-one",
              status: "available",
              resetType: "codexRateLimits",
              grantedAt: 1700000000,
              title: "Gift",
              description: "Your bonus reset restores Codex limits.",
            },
          ],
        },
      };
      const resource = parseCodexAccountResources(payload, "codex-default", at);
      const snapshot = parseCodexRateLimitsResponse(payload, at, "codex-default")[0]!;
      expect(snapshot.constraints.map((c) => c.id)).toEqual(["default:primary"]);
      expect(resource.balances?.value?.[0]).toMatchObject({
        amount,
        currency: null,
        decimal_places: null,
      });
      expect(resource.spending?.value?.[0]).toMatchObject({
        used: "12.3400",
        limit: "100.0000",
        unit: "provider_amount",
      });
      expect(resource.resets?.value?.[0]).toMatchObject({
        available_count: 5,
        description: "Resets Codex rate limits.",
        grants: [{ id: "credit-one", description: "Your bonus reset restores Codex limits." }],
      });
      expect(quotaSnapshotAvailability(snapshot, { now: at }).state).toBe("exhausted");
    },
  );
  it.each([true, false, null])(
    "gives contextual Codex diagnostics including explicit %s",
    (value) => {
      const observation = parseCodexAccountResources(
        {
          rateLimits: {
            spendControlReached: value,
            ordinaryUsageAllowed: value,
            rateLimitReachedType: null,
          },
        },
        "work",
        at,
      );
      expect(observation.diagnostics?.value?.[0]?.detail).toBe(
        value === true
          ? "Spending limit reached"
          : value === false
            ? "Spending limit not reached"
            : "Spending-limit state not reported",
      );
      expect(observation.diagnostics?.value).toHaveLength(3);
      expect(
        observation.diagnostics?.value?.some((d) => d.detail === "true" || d.detail === "false"),
      ).toBe(false);
    },
  );
  it.each([null, [], [{ id: "one", status: "unknown" }]])(
    "does not infer count from detail inventory %j",
    (credits) => {
      const result = parseCodexAccountResources(
        { rateLimitResetCredits: { availableCount: 0, credits } },
        "work",
        at,
      );
      expect(result.resets?.value?.[0]?.available_count).toBe(0);
      expect(result.resets?.value?.[0]?.grants === null).toBe(credits === null);
    },
  );
  it("keeps Claude spend separate from balance, explicit scales, granted reset and session refill", () => {
    const result = parseClaudeAccountResources(
      {
        extra_usage: {
          is_enabled: true,
          used_credits: 1.25,
          monthly_limit: 0,
          currency: "USD",
          decimal_places: 4,
        },
        cedar_ember: {
          eligible: true,
          next_grant_id: "g",
          grants: [
            {
              id: "g",
              resets_left: 1,
              resets_total: 2,
              usable_now: true,
              clears: ["five_hour", "seven_day"],
            },
          ],
        },
        juniper_tide: { eligible: true, available: true, arm: "reset", resets_per_week: 1 },
      },
      "claude-default",
      at,
    );
    expect(result.spending?.value?.[0]).toMatchObject({
      used: "1.25",
      limit: "0",
      decimal_places: 4,
    });
    expect(result).not.toHaveProperty("balances");
    expect(result.resets?.value).toMatchObject([
      { id: "claude_granted", available_count: 1, weekly_limit_applies: false },
      {
        id: "claude_session_refill",
        available_count: null,
        usable_now: true,
        weekly_limit_applies: true,
      },
    ]);
    expect(result.resets?.value?.[0]?.grants?.[0]?.description).toBe(
      "Resets 5-hour session and weekly limits.",
    );
    expect(result.resets?.value?.[1]?.description).toContain("Weekly limits still apply");
    expect(
      parseClaudePrepaid({ amount: 0, currency: "USD" }, "work", at).balances?.value?.[0],
    ).toMatchObject({ amount: "0", unit: "minor", has_balance: false });
    expect(() => parseClaudePrepaid({ amount: null }, "work", at)).toThrow("not_reported");
    expect(
      parseClaudeAccountResources({ extra_usage: null, cedar_ember: null }, "work", at),
    ).not.toHaveProperty("spending");
  });
  it("keeps usability unknown when native grant or refill status is missing", () => {
    const codex = parseCodexAccountResources(
      { rateLimitResetCredits: { credits: [{ id: "sparse" }] } },
      "work",
      at,
    );
    expect(codex.resets?.value?.[0]?.grants?.[0]?.usable_now).toBeNull();
    const claude = parseClaudeAccountResources(
      {
        cedar_ember: { eligible: true, grants: [{ id: "sparse" }] },
        juniper_tide: { eligible: true, available: true },
      },
      "work",
      at,
    );
    expect(claude.resets?.value?.every((offer) => offer.usable_now === null)).toBe(true);
    const partial = parseClaudeAccountResources(
      { cedar_ember: { eligible: true, grants: [{}] } },
      "work",
      at,
    );
    expect(partial.resets?.value?.[0]).toMatchObject({ available_count: null, usable_now: null });
  });
  it("preserves strict legacy quota and exposes typed resources only through opt-in", () => {
    const observation = parseCodexAccountResources(
      { rateLimitResetCredits: { availableCount: 2, credits: null } },
      "work",
      at,
    );
    const resources = [
      AccountResourceSnapshot.parse({
        balances: emptyResourceFacet(),
        spending: emptyResourceFacet(),
        resets: emptyResourceFacet(),
        diagnostics: emptyResourceFacet(),
        ...observation,
      }),
    ];
    const raw = {
      snapshots: parseCodexRateLimitsResponse(
        { rateLimits: { primary: { usedPercent: null } } },
        at,
        "work",
      ),
      absences: [],
      refreshed_at: null,
    };
    const registry = { read: () => raw, readResources: () => resources } as never;
    const legacy = legacyQuotaResponse(registry, raw);
    expect(ControlQuotaResponse.safeParse(legacy).success).toBe(true);
    expect(legacy.snapshots[0]?.constraints).toContainEqual(
      expect.objectContaining({ id: "reset_credits", label: "2 reset credits available" }),
    );
    const rich = accountResourcesResponse(registry);
    expect(ControlQuotaResponse.safeParse(rich).success).toBe(false);
    expect(ControlAccountResourcesResponse.safeParse(rich).success).toBe(true);
    expect(rich.snapshots[0]?.constraints).not.toContainEqual(
      expect.objectContaining({ id: "reset_credits" }),
    );
  });
  it("keeps Codex same-key confirmation separate from Claude grant ownership uncertainty", () => {
    expect(nativeResetOutcome("codex", { outcome: "alreadyRedeemed" }).outcome).toBe(
      "already_redeemed",
    );
    expect(nativeResetOutcome("claude", { result: "already_used" }).outcome).toBe("already_used");
    expect(nativeResetOutcome("claude", { outcome: "reset" }).outcome).toBe("unknown");
  });
  it("uses native org headers for prepaid reads and never retries or exposes a 403 body", async () => {
    const transport = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { message: "private test detail" } }), {
          status: 403,
        }),
    );
    await expect(
      claudeResourceRequest("/api/oauth/organizations/fixture/prepaid/credits", "transient-token", {
        organization: "fixture",
        version: "2.1.295",
        transport,
      }),
    ).rejects.toThrow("native_account_http_403");
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        "x-organization-uuid": "fixture",
        "anthropic-version": "2023-06-01",
        "anthropic-client-platform": "claude_code_cli",
        "User-Agent": "claude-cli/2.1.295 (external, cli, client-app/claudexor)",
      },
    });
  });
});
