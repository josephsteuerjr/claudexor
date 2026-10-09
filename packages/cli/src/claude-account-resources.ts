import {
  observedResourceFacet,
  type AccountResourceObservation,
  type AccountResetOffer,
} from "@claudexor/schema";
import { claudeResourceReason, claudeResetDescription } from "@claudexor/harness-claude";

export const objectValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const amount = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const instant = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

export function parseClaudeAccountResources(
  value: unknown,
  profileId: string,
  at: Date,
): AccountResourceObservation {
  const root = objectValue(value) ?? {};
  const result: AccountResourceObservation = {
    target: { harness: "claude", profile_id: profileId },
  };
  const facet = <T>(value: T) => observedResourceFacet(value, "claude_oauth_usage", at);
  const extra = objectValue(root["extra_usage"]);
  if (extra)
    result.spending = facet([
      {
        id: "extra_usage",
        label: "Monthly extra usage",
        enabled: bool(extra["is_enabled"]),
        used: amount(extra["used_credits"]),
        limit: amount(extra["monthly_limit"]),
        unit: "minor",
        currency: text(extra["currency"]),
        decimal_places: count(extra["decimal_places"]),
        resets_at: null,
        reason: claudeResourceReason(text(extra["disabled_reason"])),
      },
    ]);
  const offers: AccountResetOffer[] = [];
  const cedar = objectValue(root["cedar_ember"]);
  if (cedar) {
    const grants = Array.isArray(cedar["grants"])
      ? cedar["grants"].flatMap((raw) => {
          const grant = objectValue(raw);
          if (!grant || !text(grant["id"])) return [];
          const clears = Array.isArray(grant["clears"])
            ? grant["clears"].filter((s): s is string => typeof s === "string")
            : [];
          return [
            {
              id: grant["id"] as string,
              label: text(grant["label"]) ?? "Granted reset",
              description: claudeResetDescription(clears),
              available_count: count(grant["resets_left"]),
              total_count: count(grant["resets_total"]),
              usable_now:
                grant["paused"] === true ||
                (text(cedar["next_grant_id"]) !== null && cedar["next_grant_id"] !== grant["id"])
                  ? false
                  : bool(grant["usable_now"]),
              starts_at: instant(grant["starts_at"]),
              expires_at: instant(grant["ends_at"]),
              clears,
            },
          ];
        })
      : null;
    const inventoryComplete =
      Array.isArray(cedar["grants"]) && grants?.length === cedar["grants"].length;
    const selected =
      grants?.find((grant) => grant.id === cedar["next_grant_id"]) ??
      (grants?.length === 1 ? grants[0] : null);
    offers.push({
      id: "claude_granted",
      kind: "granted_reset",
      label: "Granted reset",
      description: selected?.description ?? null,
      available_count:
        inventoryComplete && grants?.every((g) => g.available_count !== null)
          ? grants.reduce((n, g) => n + g.available_count!, 0)
          : null,
      eligible: bool(cedar["eligible"]),
      usable_now:
        cedar["eligible"] === false
          ? false
          : grants?.some((g) => g.usable_now === true)
            ? true
            : inventoryComplete && grants?.every((g) => g.usable_now === false)
              ? false
              : null,
      reason:
        claudeResourceReason(text(cedar["ineligible_reason"])) ??
        (cedar["exhausted"] === true ? "No reset uses remain" : null),
      resets_at: instant(cedar["cooldown_until"]),
      weekly_limit_applies: false,
      grants,
    });
  }
  const refill = objectValue(root["juniper_tide"]);
  if (refill)
    offers.push({
      id: "claude_session_refill",
      kind: "session_refill",
      label: "Refill 5-hour session",
      description: "Resets the 5-hour session limit. Weekly limits still apply.",
      available_count: refill["available"] === false ? 0 : null,
      eligible: bool(refill["eligible"]),
      usable_now:
        refill["eligible"] === false || refill["arm"] === "control"
          ? false
          : refill["arm"] === "reset"
            ? bool(refill["available"])
            : null,
      reason:
        claudeResourceReason(text(refill["ineligible_reason"])) ??
        (refill["available"] === false ? "Session refill is currently unavailable" : null),
      resets_at: instant(refill["next_available_at"]),
      weekly_limit_applies: true,
      grants: null,
    });
  if (offers.length) result.resets = facet(offers);
  return result;
}

export function parseClaudePrepaid(
  value: unknown,
  profileId: string,
  at: Date,
): AccountResourceObservation {
  const root = objectValue(value);
  if (!root || amount(root["amount"]) === null) throw new Error("prepaid_balance_not_reported");
  return {
    target: { harness: "claude", profile_id: profileId },
    balances: observedResourceFacet(
      [
        {
          id: "prepaid",
          label: "Prepaid balance",
          amount: amount(root["amount"]),
          unit: "minor",
          currency: text(root["currency"]),
          decimal_places: count(root["decimal_places"]),
          has_balance: typeof root["amount"] === "number" ? root["amount"] > 0 : null,
          unlimited: null,
        },
      ],
      "claude_prepaid",
      at,
    ),
  };
}
