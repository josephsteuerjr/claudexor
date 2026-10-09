import { beforeEach, describe, expect, it, vi } from "vitest";
import { consumeNativeReset } from "./account-reset-services.js";
import { requestCodexAccount } from "./codex-quota-source.js";
import { claudeResourceRequest } from "./claude-resource-transport.js";
vi.mock("./codex-quota-source.js", () => ({ requestCodexAccount: vi.fn() }));
vi.mock("./claude-resource-transport.js", () => ({ claudeResourceRequest: vi.fn() }));
vi.mock("./claude-oauth-credential.js", () => ({
  readClaudeOauthCredential: vi.fn(async () => ({ accessToken: "fixture-only" })),
  readClaudeOauthOrganization: vi.fn(async () => ({
    organizationUuid: "org-fixture",
    accountUuid: "user-fixture",
  })),
}));
const binding = {
  harness: "claude",
  locator: "/fixture/native",
  fingerprint: "fixture-hash",
  program: "cedar_ember",
  grant_id: "g-frozen",
  native_request_id: "native-key-frozen",
};
beforeEach(() => vi.clearAllMocks());
describe("native reset transport recipes", () => {
  it("sends the frozen cedar grant and request id, interpreting already_used without own success", async () => {
    vi.mocked(claudeResourceRequest).mockResolvedValue({ result: "already_used" });
    expect(await consumeNativeReset(binding)).toMatchObject({ outcome: "already_used" });
    expect(claudeResourceRequest).toHaveBeenCalledExactlyOnceWith(
      "/api/organizations/org-fixture/reset_rate_limits",
      "fixture-only",
      { body: { program: "cedar_ember", grant_id: "g-frozen", request_id: "native-key-frozen" } },
    );
  });
  it("uses juniper's native program-only body and does not invent a server request id", async () => {
    vi.mocked(claudeResourceRequest).mockResolvedValue({ result: "reset" });
    await consumeNativeReset({ ...binding, program: "juniper_tide", grant_id: null });
    expect(claudeResourceRequest).toHaveBeenCalledExactlyOnceWith(
      "/api/organizations/org-fixture/reset_rate_limits",
      "fixture-only",
      { body: { program: "juniper_tide" } },
    );
  });
  it("preserves a safe HTTP refusal without claiming a reset or exposing its body", async () => {
    vi.mocked(claudeResourceRequest).mockRejectedValue(
      Object.assign(new Error("private body fixture-secret"), { status: 403 }),
    );
    const result = await consumeNativeReset(binding);
    expect(result.outcome).toBe("unknown");
    expect(result.detail).toContain("HTTP 403");
    expect(result.detail).not.toContain("fixture-secret");
    expect(claudeResourceRequest).toHaveBeenCalledOnce();
  });
  it("uses the account consume RPC with the original native key and credit id", async () => {
    vi.mocked(requestCodexAccount).mockResolvedValue({ outcome: "alreadyRedeemed" });
    expect(await consumeNativeReset({ ...binding, harness: "codex" })).toMatchObject({
      outcome: "already_redeemed",
    });
    expect(requestCodexAccount).toHaveBeenCalledExactlyOnceWith(
      binding.locator,
      undefined,
      undefined,
      undefined,
      undefined,
      "account/rateLimitResetCredit/consume",
      { idempotencyKey: "native-key-frozen", creditId: "g-frozen" },
    );
  });
});
