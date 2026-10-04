import type { HarnessEvent, VendorFailureEvidence } from "@claudexor/schema";
import { VendorFailureEvidence as VendorFailureSchema } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import { claudeTerminalContextEvent } from "./context-signals.js";
import type { ClaudeEventParser } from "./parse.js";

/** Native stdout result evidence, not a search through model prose. Older
 * CLIs retain the API sentence but omit api_error_code; that remains unknown
 * and keeps ordinary account failover. Context/turn-control keep their owners. */
export function withClaudeApiFailureParser(
  parse: ClaudeEventParser,
  binaryPath: string | null,
): ClaudeEventParser {
  let installedVersion: string | null = null;
  return (obj, sessionId) => {
    if (obj?.type === "system" && obj.subtype === "init") {
      installedVersion =
        typeof obj.claude_code_version === "string" && obj.claude_code_version.trim()
          ? obj.claude_code_version
          : null;
    }
    const parsed = parse(obj, sessionId);
    if (
      obj?.type !== "result" ||
      obj.is_error !== true ||
      obj.subtype === "error_max_turns" ||
      obj.subtype === "error_max_structured_output_retries" ||
      !Number.isInteger(obj.api_error_status) ||
      obj.api_error_status < 400 ||
      obj.api_error_status > 599 ||
      claudeTerminalContextEvent(obj.terminal_reason, sessionId, nowIso()) !== null
    )
      return parsed;
    const code =
      typeof obj.api_error_code === "string" && obj.api_error_code.length > 0
        ? obj.api_error_code
        : null;
    const message = typeof obj.result === "string" ? redactSecrets(obj.result) : null;
    const vendor = VendorFailureSchema.safeParse({
      code,
      message: message?.slice(0, 4000) ?? null,
      source: "claude_stdout",
    });
    const refusal =
      code === "claude_code_version_too_old"
        ? {
            kind: "vendor_cli_too_old" as const,
            native_code: "claude_code_version_too_old" as const,
            source: "claude_stdout" as const,
            binary_path: binaryPath,
            installed_version: installedVersion,
          }
        : undefined;
    return [
      // Replace the result parser's generic subtype error with the native
      // API cause; usage and all non-error evidence keep their order.
      ...(parsed ?? []).filter((event) => event.type !== "error"),
      {
        type: "error",
        session_id: sessionId,
        ts: nowIso(),
        error: message || `Claude API request failed (HTTP ${obj.api_error_status})`,
        ...(refusal ? { request_refusal: refusal } : {}),
        payload: {
          api_error_status: obj.api_error_status,
          ...(vendor.success ? { vendor_failure: vendor.data } : {}),
        },
      },
    ];
  };
}

/** Attach only this invocation's native failure to its actual failed exit,
 * through the existing terminal provenance channel shared with Codex. */
export async function* withClaudeVendorFailure(
  events: AsyncIterable<HarnessEvent>,
): AsyncGenerator<HarnessEvent> {
  let vendor: VendorFailureEvidence | null = null;
  for await (const event of events) {
    if (event.type === "error") {
      const parsed = VendorFailureSchema.safeParse(event.payload?.["vendor_failure"]);
      vendor = parsed.success ? parsed.data : null;
    }
    if (event.type === "message" && event.final) vendor = null;
    if (
      event.type === "completed" &&
      vendor &&
      !event.aborted &&
      !event.payload?.["aborted"] &&
      !event.payload?.["exit_signal"] &&
      event.payload?.["harness_reported_error"] === true
    ) {
      yield { ...event, payload: { ...event.payload, vendor_failure: vendor } };
    } else yield event;
  }
}
