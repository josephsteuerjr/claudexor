import { describe, expect, it } from "vitest";
import { CodexRpcError, parseCodexRpcError, codexRpcErrorDetail } from "./rpc-error.js";

describe("Codex native RPC failure provenance", () => {
  it("retains actual native codes without inferring auth from an HTTP-like error number", () => {
    const error = parseCodexRpcError({
      code: -32603,
      message: "The vendor refused the read",
      data: { error: { code: "missing_scope" }, http_status: 403 },
    });
    expect(error).toBeInstanceOf(CodexRpcError);
    expect(JSON.parse(codexRpcErrorDetail(error))).toEqual({
      rpc_code: -32603,
      native_code: "missing_scope",
      message: "The vendor refused the read",
    });
  });

  it("redacts message secrets and never serializes arbitrary provider data", () => {
    // Built at runtime: the CI secret scan matches token-shaped literals in tracked files.
    const secret = ["sk", "abcdefghijklmnopqrstuvwxyz1234567890"].join("-");
    const error = parseCodexRpcError({
      code: -32000,
      message: `rejected ${secret}`,
      data: { access_token: "opaque-provider-secret", unrelated: "private diagnostic" },
    });
    const detail = codexRpcErrorDetail(error);
    expect(detail).not.toContain(secret);
    expect(detail).not.toContain("opaque-provider-secret");
    expect(detail).not.toContain("private diagnostic");
    expect(JSON.parse(detail).rpc_code).toBe(-32000);
  });

  it.each([null, [], "refused", { code: Infinity, message: {} }])(
    "keeps malformed refusal unknown: %j",
    (value) => {
      const error = parseCodexRpcError(value);
      expect(error.code).toBeNull();
      expect(error.message).toBe("Codex app-server request failed");
    },
  );
});
