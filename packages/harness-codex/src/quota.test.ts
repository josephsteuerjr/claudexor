import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { codexAppServerEvents } from "./app-server-protocol.js";
import { decorateCodexEvent } from "./event-decoration.js";
import { parseCodexRateLimitsResponse } from "./quota.js";

// Synthetic numeric values; the recorded fixture below proves the wire envelope.
const measured = {
  rateLimits: {
    limitId: "codex",
    planType: "plus",
    primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: 1791151200 },
    secondary: { usedPercent: 43, windowDurationMins: 10080, resetsAt: 1791751200 },
  },
};
const parse = (params: unknown) =>
  codexAppServerEvents({ method: "account/rateLimits/updated", params }, "session-quota", {});

describe("Codex native quota notifications", () => {
  it("retains measured windows as incremental observations, independent of full-reader inventory", () => {
    const full = parseCodexRateLimitsResponse(measured, new Date(), "account-a")[0]!;
    const events = parse(measured)!;
    expect(events).toHaveLength(2);
    expect(events.flatMap((event) => event.quota!.constraints)).toEqual(full.constraints);
    expect(full.source).toBe("codex_app_server");
    for (const event of events) {
      expect(event.type).toBe("status");
      expect(event.quota?.source).toBe("codex_app_server_event");
      expect(event.quota?.constraints).toHaveLength(1);
      expect(event.quota?.plan_label).toBe("plus");
      expect(event.usage).toBeUndefined();
      expect(event.rate_limit).toBeUndefined();
      expect(HarnessEvent.safeParse(event).success).toBe(true);
    }
  });

  it("recognizes the recorded notification without claiming sanitized zero/reset values are fresh headroom", () => {
    const frames = readFileSync(
      new URL("../fixtures/app-server/recorded-steer-0.156.1.jsonl", import.meta.url),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((frame) => frame["method"] === "account/rateLimits/updated");
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      const [event] = codexAppServerEvents(frame, "recorded-session", {})!;
      expect(event?.quota?.constraints[0]).toMatchObject({
        id: "codex:primary",
        used_ratio: 0,
        window_seconds: null,
        resets_at: "1970-01-01T00:00:00.000Z",
      });
    }
  });

  it("keeps an additional bucket's unproven model applicability diagnostic", () => {
    const events = parse({
      rateLimitsByLimitId: {
        codex: measured.rateLimits,
        future_model: {
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1791151200 },
        },
      },
    })!;
    expect(events.filter((event) => event.quota)).toHaveLength(2);
    expect(events[2]?.quota).toBeUndefined();
    expect(events[2]?.payload?.["native_quota"]).toMatchObject({
      window_id: "future_model:primary",
      used_ratio: 1,
      applicability: "unknown",
    });
    expect(events[2]?.rate_limit).toBeUndefined();
  });

  it("preserves null numbers and malformed resets without throwing into the run lifecycle", () => {
    const [event] = parse({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: null,
          windowDurationMins: Infinity,
          resetsAt: 1e300,
        },
      },
    })!;
    expect(event?.quota?.constraints[0]).toMatchObject({
      used_ratio: null,
      window_seconds: null,
      resets_at: null,
    });
    expect(parse({ rateLimits: [] })).toEqual([]);
  });

  it("decorates direct observations with the selected profile even under stream-only evidence", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "session-quota",
      intent: "implement",
      cwd: process.cwd(),
      prompt: "test",
      evidence_policy: "stream_only",
      credential_profile: {
        profile_id: "work",
        harness_id: "codex",
        display_name: "Work",
        credential_kind: "config_dir_login",
        isolation_locator: "/fixture/profile",
      },
    });
    const [event] = parse(measured)!;
    const decorated = decorateCodexEvent(event!, {
      spec,
      env: {},
      credentialRoute: "vendor_native",
      credentialSource: "native_session",
      tempCodexHome: null,
      model: null,
    });
    expect(decorated).toMatchObject({
      credential_profile_id: "work",
      credential_route: "vendor_native",
      quota: { subject_id: "work", source: "codex_app_server_event" },
    });
    expect(decorated.usage).toBeUndefined();
  });
});
