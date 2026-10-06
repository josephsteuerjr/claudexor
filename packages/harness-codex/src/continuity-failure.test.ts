import { expect, it, vi } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { codexContinuity } from "./continuity.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, copyFileSync: vi.fn(fs.copyFileSync) };
});

it("cleans a destination whose copied size fails verification", async () => {
  const config = process.env.CLAUDEXOR_CONFIG_DIR!;
  const a = join(config, "profiles", "a"),
    b = join(config, "profiles", "b");
  const rel = join("sessions", "2026", "10", "06", "rollout-fixture-sid.jsonl");
  mkdirSync(join(a, rel, ".."), { recursive: true });
  mkdirSync(b, { recursive: true });
  const source = join(realpathSync(a), rel),
    target = join(realpathSync(b), rel);
  writeFileSync(source, "complete history");
  vi.mocked(copyFileSync).mockImplementationOnce((_source, dest) => writeFileSync(dest, "cut"));
  const moved = await codexContinuity.move(
    { file: source, sidecars: [], nativeSessionId: "sid" },
    { CLAUDEXOR_PROFILE_LOCATOR: a },
    { CLAUDEXOR_PROFILE_LOCATOR: b },
    "/w",
  );
  expect(moved).toMatchObject({ ok: false, reason: "rollout copy size mismatch" });
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(source, "utf8")).toBe("complete history");
});
