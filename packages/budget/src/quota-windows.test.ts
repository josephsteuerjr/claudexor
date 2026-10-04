import { describe, expect, it } from "vitest";
import type { QuotaSnapshot } from "@claudexor/schema";
import { BudgetLedger } from "./ledger.js";

const now = Date.parse("2026-10-04T00:00:00Z");
function snapshot(id: string, ratio: number, models?: string[]): QuotaSnapshot {
  return {
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      subject_id: "work",
      plan_label: null,
    },
    source: "claude_rate_limit_event",
    observed_at: new Date(now).toISOString(),
    freshness: "fresh",
    constraints: [
      {
        id,
        label: id,
        used_ratio: ratio,
        window_seconds: 18000,
        resets_at: "2026-10-05T00:00:00Z",
        cooldown_until: null,
        ...(models ? { applies_to_models: models } : {}),
      },
    ],
  };
}

describe("budget incremental quota storage", () => {
  it("retains a binding sibling window instead of the last source receipt", () => {
    const ledger = new BudgetLedger();
    ledger.observeQuotaSnapshot(snapshot("five_hour", 1));
    ledger.observeQuotaSnapshot(snapshot("seven_day", 0.1));
    expect(ledger.cooldownActive("claude", "vendor_native", "work", now, "opus")).toBe(true);
    expect(ledger.cooldownActive("claude", "vendor_native", "other", now, "opus")).toBe(false);
    ledger.observeQuotaSnapshot(snapshot("five_hour", 0.1));
    expect(ledger.cooldownActive("claude", "vendor_native", "work", now, "opus")).toBe(false);
  });

  it("does not collapse independent applicability on the same vendor window", () => {
    const ledger = new BudgetLedger();
    ledger.observeQuotaSnapshot(snapshot("weekly", 1, ["opus"]));
    ledger.observeQuotaSnapshot(snapshot("weekly", 0.1, ["sonnet"]));
    expect(ledger.cooldownActive("claude", "vendor_native", "work", now, "opus")).toBe(true);
    expect(ledger.cooldownActive("claude", "vendor_native", "work", now, "sonnet")).toBe(false);
    expect(ledger.cooldownActive("claude", "managed_api_key", "work", now, "opus")).toBe(false);
  });
});
