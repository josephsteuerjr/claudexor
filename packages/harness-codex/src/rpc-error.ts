import { redactSecrets } from "@claudexor/util";

/** Native JSON-RPC provenance; transport errors never acquire this type. */
export class CodexRpcError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
    readonly data: unknown = null,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export function parseCodexRpcError(value: unknown): CodexRpcError {
  const error = object(value);
  return new CodexRpcError(
    typeof error?.["code"] === "number" && Number.isFinite(error["code"]) ? error["code"] : null,
    typeof error?.["message"] === "string" ? error["message"] : "Codex app-server request failed",
    error?.["data"],
  );
}

/** Keep meaningful supplied codes without persisting arbitrary provider data
 * or inferring auth/quota semantics from its prose or an HTTP-like number. */
export function codexRpcErrorDetail(error: CodexRpcError): string {
  const data = object(error.data);
  const nativeCode = data?.["code"] ?? object(data?.["error"])?.["code"];
  const code = typeof nativeCode === "string" ? redactSecrets(nativeCode).slice(0, 100) : null;
  const message = redactSecrets(error.message).slice(0, 350);
  return JSON.stringify({ rpc_code: error.code, ...(code ? { native_code: code } : {}), message });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
