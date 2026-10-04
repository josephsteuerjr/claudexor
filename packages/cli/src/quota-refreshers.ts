import type { QuotaRefreshCycle, QuotaVendorRefresher } from "@claudexor/daemon";
import type { QuotaSource } from "@claudexor/schema";
import { refreshClaudeOauthUsageQuota } from "./claude-oauth-usage.js";
import { refreshClaudeStatuslineQuota } from "./claude-statusline.js";
import { refreshCodexQuota } from "./codex-quota-source.js";
import { refreshAgyQuota } from "./agy-quota-source.js";
import type { QuotaDiagnosticSink } from "./quota-refresh-diagnostics.js";

export interface QuotaRefresherRegistration {
  readonly source: QuotaSource;
  /** Pacing lane (per-vendor poll pacing): the vendor whose credential
   * fan-out this refresher performs. Must equal the source trait's
   * refreshDemandHarness whenever that is non-null (parity test);
   * claude_statusline reads a local spool but publishes claude-subject
   * evidence, so it rides the claude lane. */
  readonly vendor: QuotaVendorRefresher["vendor"];
  readonly refresh: (
    cycle?: QuotaRefreshCycle,
    diagnostic?: QuotaDiagnosticSink,
  ) => ReturnType<QuotaVendorRefresher["refresh"]>;
}

/** The daemon's top-level refreshers and the source each owns. Schema traits
 * independently declare which sources must appear here; the parity test keeps
 * composition, vocabulary, and pacing-lane assignment in lockstep. Only the
 * claude OAuth source reads the cycle kind (an explicit foreground refresh
 * re-presents a token it remembers as rejected); the others take no options
 * from the cycle. */
export const QUOTA_REFRESHER_REGISTRATIONS = [
  {
    source: "codex_app_server",
    vendor: "codex",
    refresh: (cycle?: QuotaRefreshCycle, diagnostic?: QuotaDiagnosticSink) =>
      refreshCodexQuota({ diagnostic, foreground: cycle?.foreground }),
  },
  { source: "claude_statusline", vendor: "claude", refresh: () => refreshClaudeStatuslineQuota() },
  {
    source: "claude_oauth_usage",
    vendor: "claude",
    refresh: (cycle?: QuotaRefreshCycle, diagnostic?: QuotaDiagnosticSink) =>
      refreshClaudeOauthUsageQuota(diagnostic ? { diagnostic } : {}, cycle),
  },
  { source: "agy_command_usage", vendor: "agy", refresh: () => refreshAgyQuota() },
] as const satisfies readonly QuotaRefresherRegistration[];

export function quotaRefreshers(diagnostic?: QuotaDiagnosticSink): QuotaVendorRefresher[] {
  return QUOTA_REFRESHER_REGISTRATIONS.map(({ vendor, refresh }) => ({
    vendor,
    refresh: (cycle) => refresh(cycle, diagnostic),
  }));
}
