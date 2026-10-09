import { describe, expect, it } from "vitest";
import { claudeRateLimitEvents } from "./context-signals.js";

const ts = "2026-10-04T11:00:00.000Z";
const reset = 1791151200;
const parse = (info: Record<string, unknown>) =>
  claudeRateLimitEvents({ rate_limit_info: info }, "native-profile-session", ts);

describe("Claude native quota observations", () => {
  it("translates overage diagnostics and explicitly clears absent reasons", () => {
    const active = parse({
      overageStatus: "rejected",
      isUsingOverage: false,
      overageDisabledReason: "org_level_disabled",
    })[0]!;
    expect(active.account_usage).toContainEqual({
      code: "org_level_disabled",
      detail: "Extra usage is disabled by the organization",
    });
    expect(active.account_usage).toContainEqual({
      code: "is_using_overage",
      detail: "Not currently using extra usage",
    });
    const cleared = parse({
      overageStatus: null,
      isUsingOverage: null,
      overageDisabledReason: null,
    })[0]!;
    expect(cleared.account_usage).toContainEqual({
      code: "overage_disabled_reason",
      detail: "No extra-usage unavailability reason reported",
    });
    expect(cleared.account_usage).not.toContainEqual(
      expect.objectContaining({ code: "org_level_disabled" }),
    );
    expect(active.quota).toBeUndefined();
  });
  it("keeps measured sibling windows and prefers unified values over a duplicate dominant row", () => {
    const events = parse({
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.3,
      resetsAt: reset,
      overageStatus: "rejected",
      unifiedWindows: {
        five_hour: { utilization: 0.4, resetsAt: reset },
        seven_day: { utilization: 0.2, resetsAt: reset + 86400 },
      },
    });
    expect(events.map((event) => event.quota?.constraints)).toEqual([
      [expect.objectContaining({ id: "five_hour", used_ratio: 0.4, window_seconds: 18000 })],
      [expect.objectContaining({ id: "seven_day", used_ratio: 0.2, window_seconds: 604800 })],
    ]);
    expect(events.every((event) => event.ts === ts && event.type === "status")).toBe(true);
    expect(events.every((event) => !event.rate_limit && !event.usage)).toBe(true);
    expect(events.every((event) => event.quota?.source === "claude_rate_limit_event")).toBe(true);
  });

  it("preserves unknown conditional/model scope as numeric diagnostic evidence", () => {
    const events = parse({
      status: "allowed_warning",
      unifiedWindows: {
        seven_day_overage_included: { utilization: 0.9, resetsAt: reset },
        next_vendor_model: { utilization: 0.7, resetsAt: reset },
      },
    });
    expect(events).toHaveLength(2);
    expect(events.every((event) => !event.quota && !event.rate_limit)).toBe(true);
    expect(events[0]?.payload?.["native_quota"]).toMatchObject({
      window_id: "seven_day_overage_included",
      used_ratio: 0.9,
      applicability: "unknown",
    });
    expect(JSON.stringify(events)).not.toContain("fable");
  });

  it("does not invent usage from permission or rejection and preserves known family scope", () => {
    expect(parse({ status: "allowed", rateLimitType: "five_hour" })).toEqual([]);
    const events = parse({ status: "rejected", rateLimitType: "seven_day_opus", resetsAt: reset });
    expect(events.find((event) => event.quota)?.quota?.constraints[0]).toMatchObject({
      used_ratio: null,
      applies_to_models: expect.arrayContaining(["opus"]),
    });
    expect(events.filter((event) => event.rate_limit)).toHaveLength(1);
  });

  it.each([NaN, Infinity, -1, 2, "0.5", null])(
    "keeps malformed utilization unknown: %s",
    (utilization) => {
      const [event] = parse({
        status: "allowed",
        rateLimitType: "five_hour",
        utilization,
        resetsAt: reset,
      });
      expect(event?.quota?.constraints[0]?.used_ratio).toBeNull();
    },
  );

  it("ignores unrepresentable timestamps without crashing either evidence path", () => {
    const events = parse({
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 0.2,
      resetsAt: 1e300,
    });
    expect(events.find((event) => event.quota)?.quota?.constraints[0]?.resets_at).toBeNull();
    expect(events.find((event) => event.rate_limit)?.rate_limit?.resets_at).toBeNull();
  });
});
