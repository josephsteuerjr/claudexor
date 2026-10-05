import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTINUITY_PROFILE_LOCATOR_ENV } from "@claudexor/core";
import { codexContinuity, codexStoreHome, findCodexRolloutParts } from "./continuity.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

const TID = "0d6a2b0e-7c7f-4a3f-9d2e-6b1f2c3d4e5f";

function home(name: string): string {
  // Registered CODEX_HOMEs live under the Claudexor-owned root (the test
  // sandbox CLAUDEXOR_CONFIG_DIR), so the canonicalizer admits them.
  const dir = join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", `codex-${name}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  // The home canonicalizer resolves symlinks (macOS /var → /private/var).
  return realpathSync(dir);
}

function seed(codexHome: string, parts: string[]): string[] {
  const day = join(codexHome, "sessions", "2026", "10", "06");
  mkdirSync(day, { recursive: true });
  return parts.map((name) => {
    const file = join(day, name);
    writeFileSync(file, `part ${name}\n`);
    return file;
  });
}

describe("codex continuity", () => {
  it("finds every rollout part by filename, .jsonl.zst included, with no DB row", () => {
    const a = home("a");
    const [main, zst] = seed(a, [
      `rollout-2026-10-06T10-00-00-${TID}.jsonl`,
      `rollout-2026-10-06T10-00-00-${TID}.jsonl.zst`,
      "rollout-2026-10-06T09-00-00-ffffffff-0000-0000-0000-000000000000.jsonl",
    ]);
    expect(findCodexRolloutParts(join(a, "sessions"), TID).sort()).toEqual([main, zst].sort());
    expect(findCodexRolloutParts(join(a, "nope"), TID)).toEqual([]);
    expect(codexStoreHome({ [CONTINUITY_PROFILE_LOCATOR_ENV]: a })).toBe(a);
  });

  it("locates the thread (main .jsonl first, other parts as sidecars) and misses an unknown id", async () => {
    const a = home("a");
    const env = { [CONTINUITY_PROFILE_LOCATOR_ENV]: a };
    expect(await codexContinuity.locate({ nativeSessionId: TID, cwd: "/w" }, env)).toEqual({
      found: false,
    });
    const [main, zst] = seed(a, [
      `rollout-2026-10-06T10-00-00-${TID}.jsonl.zst`,
      `rollout-2026-10-06T10-00-00-${TID}.jsonl`,
    ]);
    const located = await codexContinuity.locate({ nativeSessionId: TID, cwd: "/w" }, env);
    expect(located).toMatchObject({ found: true, file: zst, sidecars: [main] });
  });

  it("moves every part to the same relative path under the target home, retires the sources, never auth.json", async () => {
    const a = home("a");
    const b = home("b");
    writeFileSync(join(a, "auth.json"), '{"tokens":"never-copied"}');
    const [main, zst] = seed(a, [
      `rollout-2026-10-06T10-00-00-${TID}.jsonl`,
      `rollout-2026-10-06T10-00-00-${TID}.jsonl.zst`,
    ]);
    const envA = { [CONTINUITY_PROFILE_LOCATOR_ENV]: a };
    const envB = { [CONTINUITY_PROFILE_LOCATOR_ENV]: b };
    const moved = await codexContinuity.move({ file: main!, sidecars: [zst!] }, envA, envB, "/w");
    expect(moved).toEqual({ ok: true, resumeRef: { nativeSessionId: TID } });
    const rel = join("sessions", "2026", "10", "06");
    expect(
      readFileSync(join(b, rel, `rollout-2026-10-06T10-00-00-${TID}.jsonl`), "utf8"),
    ).toContain("part ");
    expect(existsSync(join(b, rel, `rollout-2026-10-06T10-00-00-${TID}.jsonl.zst`))).toBe(true);
    expect(existsSync(main!)).toBe(false);
    expect(existsSync(zst!)).toBe(false);
    expect(existsSync(join(b, "auth.json"))).toBe(false);
    expect(await codexContinuity.locate({ nativeSessionId: TID, cwd: "/w" }, envB)).toMatchObject({
      found: true,
      file: join(b, rel, `rollout-2026-10-06T10-00-00-${TID}.jsonl`),
    });
    // A part outside the sessions dir is refused before anything is copied.
    const stray = join(a, "auth.json");
    expect(
      await codexContinuity.move({ file: stray, sidecars: [] }, envA, envB, "/w"),
    ).toMatchObject({
      ok: false,
    });
  });

  it("types the vendor's own rejection code for carried reasoning, from the rollout code or its error text", () => {
    const reject = codexContinuity.rejectsCarriedState!;
    const base = { session_id: "s", ts: "t" } as const;
    expect(
      reject({
        ...base,
        type: "completed",
        payload: { vendor_failure: { code: "invalid_encrypted_content" } },
      }),
    ).toBe(true);
    expect(reject({ ...base, type: "error", error: "turn failed: Request blocked." })).toBe(true);
    expect(reject({ ...base, type: "error", error: "stream disconnected" })).toBe(false);
    expect(reject({ ...base, type: "message", text: "invalid_encrypted_content" })).toBe(false);
  });
});
