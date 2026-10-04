import { describe, expect, it, vi } from "vitest";
import { createClaudeAdapter } from "./index.js";

const ready = {
  detectVersion: async () => "2.1.288",
  installation: () => ({ path: "/fixture/claude", advisory: null as string | null }),
  probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "fixture" }),
  probeEffortLevels: async () => ({ levels: ["high"] as const, live: true }),
  probeAuthStatus: async () => ({
    loggedIn: true,
    authed: true,
    authMethod: "claude.ai",
    probeError: null,
  }),
  anthropicApiKey: () => null,
  claudeOAuthToken: () => null,
};

describe("Claude selected installation disclosure", () => {
  it("keeps a working fallback available while showing the skipped preferred install", async () => {
    const advisory = "Using /fixture/claude; skipped /preferred/claude (symlink target is missing)";
    const adapter = createClaudeAdapter({
      ...ready,
      installation: () => ({ path: "/fixture/claude", advisory }),
    });
    const report = await adapter.doctor({ cwd: "/fixture", authPreference: "subscription" });
    expect(report.status).toBe("ok");
    expect(report.checks.find((x) => x.id === "installed")).toEqual({
      id: "installed",
      status: "pass",
      detail: `2.1.288 at /fixture/claude — ${advisory}`,
    });
    expect(report.reasons).toEqual([]);
  });

  it("keeps the installed row quiet when no earlier install was broken", async () => {
    const report = await createClaudeAdapter(ready).doctor({
      cwd: "/fixture",
      authPreference: "subscription",
    });
    expect(report.checks.find((x) => x.id === "installed")?.detail).toBe(
      "2.1.288 at /fixture/claude",
    );
  });

  it("uses the exact PATH patch for version, help and selected-installation evidence", async () => {
    const detectVersion = vi.fn(ready.detectVersion);
    const probeReadonlyProfile = vi.fn(ready.probeReadonlyProfile);
    const installation = vi.fn(ready.installation);
    await createClaudeAdapter({
      ...ready,
      detectVersion,
      probeReadonlyProfile,
      installation,
    }).doctor({
      cwd: "/fixture",
      env: { PATH: "/explicit/tools" },
      authPreference: "subscription",
    });
    expect(detectVersion).toHaveBeenCalledWith(undefined, "/explicit/tools");
    expect(probeReadonlyProfile).toHaveBeenCalledWith(undefined, "/explicit/tools");
    expect(installation).toHaveBeenCalledWith(expect.any(String), "/explicit/tools");
  });

  it("preserves missing-install evidence in both doctor and discovery", async () => {
    const advisory = "Cannot launch /preferred/claude (symlink target is missing)";
    const adapter = createClaudeAdapter({
      ...ready,
      detectVersion: async () => null,
      installation: () => ({ path: null, advisory }),
    });
    const report = await adapter.doctor({ cwd: "/fixture" });
    expect(report.status).toBe("unavailable");
    expect(report.checks[0]?.detail).toContain(advisory);
    expect(report.reasons).toContain(advisory);
    await expect(adapter.discover()).rejects.toThrow(advisory);
  });
});
