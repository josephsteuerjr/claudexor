import { detectClaudeVersion } from "@claudexor/harness-claude";
import { parseRetryAfterHeaderMs } from "./claude-oauth-fetch.js";

/** The installed native client's identity, plus our explicit client-app tag.
 * Version discovery is auth-free; no pinned research version becomes a header. */
export async function claudeResourceHeaders(
  token: string,
  version?: string | null,
): Promise<Record<string, string>> {
  const detected = version === undefined ? await detectClaudeVersion() : version;
  const nativeVersion = detected?.match(/\d+\.\d+\.\d+/)?.[0];
  return {
    authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    accept: "application/json",
    "x-app": "cli",
    "User-Agent": nativeVersion
      ? `claude-cli/${nativeVersion} (external, cli, client-app/claudexor)`
      : "claudexor (client-app/claudexor)",
  };
}

/** Bounded native account HTTP transport. Never include response bodies or
 * bearer material in thrown diagnostics. No retries of mutation requests. */
export async function claudeResourceRequest(
  path: string,
  token: string,
  options: {
    body?: unknown;
    organization?: string;
    transport?: typeof fetch;
    version?: string | null;
  } = {},
): Promise<unknown> {
  const response = await (options.transport ?? fetch)(`https://api.anthropic.com${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      ...(await claudeResourceHeaders(token, options.version)),
      ...(options.organization
        ? {
            "x-organization-uuid": options.organization,
            "anthropic-version": "2023-06-01",
            "anthropic-client-platform": "claude_code_cli",
          }
        : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(options.body === undefined ? 10_000 : 25_000),
  });
  if (!response.ok)
    throw Object.assign(new Error(`native_account_http_${response.status}`), {
      status: response.status,
      quotaAbsenceReason: response.status === 429 ? "rate_limited" : "refresh_failed",
      retryAfterMs:
        response.status === 429
          ? parseRetryAfterHeaderMs(response.headers.get("retry-after"))
          : null,
    });
  return response.json();
}
