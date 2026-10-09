import {
  observedResourceFacet,
  type AccountResourceObservation,
  type AccountResourceSnapshot,
} from "@claudexor/schema";

const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const time = (value: unknown): string | null =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Number.isFinite(new Date(value * 1000).getTime())
    ? new Date(value * 1000).toISOString()
    : null;
const limitReasons: Record<string, string> = {
  rate_limit_reached: "Subscription rate limit reached",
  workspace_owner_credits_depleted: "Workspace owner credits depleted",
  workspace_member_credits_depleted: "Workspace member credits depleted",
  workspace_owner_usage_limit_reached: "Workspace owner spending limit reached",
  workspace_member_usage_limit_reached: "Workspace member spending limit reached",
};
function diagnostic(key: string, value: unknown) {
  const detail =
    key === "spendControlReached"
      ? value === true
        ? "Spending limit reached"
        : value === false
          ? "Spending limit not reached"
          : "Spending-limit state not reported"
      : key === "ordinaryUsageAllowed"
        ? value === true
          ? "Subscription usage allowed"
          : value === false
            ? "Subscription usage unavailable"
            : "Subscription usage permission not reported"
        : typeof value === "string"
          ? (limitReasons[value] ?? `Rate-limit reason: ${value.replaceAll("_", " ")}`)
          : "No rate-limit reason reported";
  return { code: typeof value === "string" ? value : key, detail };
}

/** Financial evidence is informational. It never enters quota constraints. */
export function parseCodexAccountResources(
  value: unknown,
  profileId: string,
  at: Date,
): AccountResourceObservation {
  const root = obj(value) ?? {};
  const byId = obj(root["rateLimitsByLimitId"]);
  const buckets =
    byId && Object.keys(byId).length
      ? Object.entries(byId)
      : [["codex", root["rateLimits"]] as const];
  const balances: NonNullable<AccountResourceSnapshot["balances"]["value"]> = [];
  const spending: NonNullable<AccountResourceSnapshot["spending"]["value"]> = [];
  const diagnostics: NonNullable<AccountResourceSnapshot["diagnostics"]["value"]> = [];
  const result: AccountResourceObservation = {
    target: { harness: "codex", profile_id: profileId },
  };
  for (const [id, raw] of buckets) {
    const bucket = obj(raw);
    if (!bucket) continue;
    const credits = obj(bucket["credits"]);
    if (credits)
      balances.push({
        id: `${id}:credits`,
        label: "Credits",
        amount: text(credits["balance"]),
        unit: "credits",
        currency: null,
        decimal_places: null,
        has_balance: bool(credits["hasCredits"]),
        unlimited: bool(credits["unlimited"]),
      });
    const limit = obj(bucket["individualLimit"]);
    if (limit)
      spending.push({
        id: `${id}:individual`,
        label: "Individual spending limit",
        enabled: null,
        used: text(limit["used"]),
        limit: text(limit["limit"]),
        unit: "provider_amount",
        currency: null,
        decimal_places: null,
        resets_at: time(limit["resetsAt"]),
        reason: bool(bucket["spendControlReached"]) === true ? "Spending limit reached" : null,
      });
    for (const key of ["spendControlReached", "ordinaryUsageAllowed", "rateLimitReachedType"]) {
      const value = bucket[key];
      if (key in bucket) diagnostics.push(diagnostic(key, value));
    }
  }
  const facet = <T>(value: T) => observedResourceFacet(value, "codex_app_server", at);
  if (balances.length) result.balances = facet(balances);
  if (spending.length) result.spending = facet(spending);
  if (diagnostics.length) result.diagnostics = facet(diagnostics);
  const resets = obj(root["rateLimitResetCredits"]);
  if (resets)
    result.resets = facet([
      {
        id: "codex_granted",
        kind: "granted_reset",
        label: "Granted reset",
        description: "Resets Codex rate limits.",
        available_count: count(resets["availableCount"]),
        eligible: null,
        usable_now: count(resets["availableCount"]) === 0 ? false : null,
        reason: count(resets["availableCount"]) === 0 ? "No reset credits available" : null,
        resets_at: null,
        weekly_limit_applies: false,
        grants: Array.isArray(resets["credits"])
          ? resets["credits"].flatMap((raw) => {
              const credit = obj(raw);
              if (!credit || !text(credit["id"])) return [];
              return [
                {
                  id: credit["id"] as string,
                  label: text(credit["title"]) ?? "Granted reset",
                  description:
                    text(credit["description"]) ??
                    (credit["resetType"] === "codexRateLimits"
                      ? "Resets Codex rate limits."
                      : null),
                  available_count:
                    credit["status"] === "available"
                      ? 1
                      : credit["status"] === "redeemed"
                        ? 0
                        : null,
                  total_count: null,
                  usable_now:
                    credit["status"] === "available"
                      ? true
                      : credit["status"] === "redeemed" || credit["status"] === "redeeming"
                        ? false
                        : null,
                  starts_at: time(credit["grantedAt"]),
                  expires_at: time(credit["expiresAt"]),
                  clears: typeof credit["resetType"] === "string" ? [credit["resetType"]] : [],
                },
              ];
            })
          : null,
      },
    ]);
  return result;
}
