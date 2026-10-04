import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { QuotaSubject } from "@claudexor/schema";
import { QuotaPollPacer, quotaPacerFileStore } from "./quota-poll-pacer.js";
import { buildRefresherLanes, selectCycleEntries } from "./quota-poll-lanes.js";

const subject: QuotaSubject = {
  harness: "claude",
  credential_route: "vendor_native",
  subject_id: "limited",
  plan_label: null,
};

describe("subject poll floors", () => {
  it("backs off repeated headerless429 per subject, never borrowing a sibling's success or route", () => {
    const pacer = new QuotaPollPacer("claude");
    const start = Date.parse("2026-10-04T10:00:00Z");
    const sibling = { ...subject, subject_id: "healthy" };
    pacer.noteRateLimited(start, null, subject);
    expect(pacer.rateLimitCooldownUntil(start, subject)).toBe(start + 60_000);
    pacer.noteSubjectSuccess(sibling);
    pacer.notePollSuccess(start, false);
    pacer.noteRateLimited(start + 60_000, null, subject);
    expect(pacer.rateLimitCooldownUntil(start + 60_000, subject)).toBe(start + 180_000);
    // The immediate producer callback and validated batch re-state one event.
    pacer.noteRateLimited(start + 60_000, null, subject);
    expect(pacer.rateLimitCooldownUntil(start + 60_000, subject)).toBe(start + 180_000);
    expect(pacer.rateLimitCooldownUntil(start, sibling)).toBeNull();
    expect(
      pacer.rateLimitCooldownUntil(start, { ...subject, credential_route: "managed_api_key" }),
    ).toBeNull();
    expect(pacer.rateLimitCooldownUntil(start)).toBeNull();
    pacer.noteSubjectSuccess(subject);
    pacer.noteRateLimited(start + 180_000, null, subject);
    expect(pacer.rateLimitCooldownUntil(start + 180_000, subject)).toBe(start + 240_000);
  });

  it("binds a previously unknown token alias to a persisted subject floor before its first request", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-pacer-alias-")));
    try {
      const store = quotaPacerFileStore(root);
      const now = Date.parse("2026-10-04T10:00:00Z");
      new QuotaPollPacer("claude", store).noteRateLimited(now, 600_000, subject);
      const restarted = new QuotaPollPacer("claude", store);
      const alias = { ...subject, subject_id: "new-alias" };
      restarted.bindCredentials([
        { subject: alias, credentialHash: "host-only-hash" },
        { subject, credentialHash: "host-only-hash" },
      ]);
      expect(restarted.rateLimitCooldownUntil(now, alias)).toBe(now + 600_000);
      expect(store.loadSubject?.(alias)).toBe(now + 600_000);
      restarted.noteCredentialChange();
      expect(restarted.rateLimitCooldownUntil(now, alias)).toBe(now + 600_000);
      expect(restarted.rateLimitCooldownUntil(now + 600_000, alias)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an obsolete credential generation cannot record an in-flight source's429", async () => {
    let current = true;
    const lanes = buildRefresherLanes([
      {
        vendor: "claude",
        refresh: async (cycle) => {
          current = false;
          cycle?.pacing?.noteRateLimited(subject, 1000, 600_000);
          return { snapshots: [] };
        },
      },
    ]);
    const selected = selectCycleEntries(lanes, null, 1000, () => current, [subject]);
    await selected.running[0]!.refresh();
    expect(lanes.lanes[0]!.pacer.rateLimitCooldownUntil(1000, subject)).toBeNull();
    current = true;
    lanes.lanes[0]!.pacer.noteRateLimited(1000, 600_000, subject);
    expect(lanes.lanes[0]!.pacer.rateLimitCooldownUntil(1000, subject)).toBe(601_000);
  });
});
