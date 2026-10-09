/** Provider vocabulary is translated at the adapter boundary; source codes
 * remain in diagnostic.code and reset grant.clears for provenance. */
export function claudeResourceReason(reason: string | null): string | null {
  if (reason === null) return null;
  const known: Record<string, string> = {
    org_level_disabled: "Extra usage is disabled by the organization",
    user_level_disabled: "Extra usage is disabled for this account",
    spend_limit_reached: "Spending limit reached",
    org_spend_limit_reached: "Organization spending limit reached",
    user_spend_limit_reached: "Account spending limit reached",
    insufficient_credits: "Insufficient prepaid credits",
    surface: "This reset is unavailable on this client surface",
    ineligible: "This account is not eligible for this reset",
    cooldown: "Reset cooldown is still active",
    not_limited: "No rate limit needs resetting",
    exhausted: "No reset uses remain",
  };
  return known[reason] ?? `Provider reason: ${reason.replaceAll("_", " ")}`;
}

export function claudeResetDescription(clears: readonly string[]): string | null {
  const scopes: Record<string, string> = {
    five_hour: "5-hour session",
    seven_day: "weekly",
    seven_day_opus: "weekly Opus",
    seven_day_sonnet: "weekly Sonnet",
  };
  if (!clears.length || clears.some((scope) => !scopes[scope])) return null;
  return `Resets ${clears.map((scope) => scopes[scope]).join(" and ")} limits.`;
}

export function claudeOverageDiagnostics(info: Record<string, unknown>) {
  const status = info["overageStatus"];
  const using = info["isUsingOverage"];
  const reason =
    typeof info["overageDisabledReason"] === "string" ? info["overageDisabledReason"] : null;
  return [
    {
      code: typeof status === "string" ? status : "overage_status",
      detail:
        status === "allowed"
          ? "Extra usage is available"
          : status === "allowed_warning"
            ? "Extra usage is available with a provider warning"
            : status === "rejected"
              ? "Extra usage is unavailable"
              : "Extra-usage availability not reported",
    },
    {
      code: "is_using_overage",
      detail:
        using === true
          ? "Currently using extra usage"
          : using === false
            ? "Not currently using extra usage"
            : "Extra-usage activity not reported",
    },
    {
      code: reason ?? "overage_disabled_reason",
      detail: claudeResourceReason(reason) ?? "No extra-usage unavailability reason reported",
    },
  ];
}
