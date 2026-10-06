import { expect, it, vi } from "vitest";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeContinuity, claudeProjectDirName } from "./continuity.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, copyFileSync: vi.fn(fs.copyFileSync), cpSync: vi.fn(fs.cpSync) };
});

it.each(["size", "sidecar"])(
  "cleans every destination after a %s verification/copy failure",
  async (failure) => {
    const config = process.env.CLAUDEXOR_CONFIG_DIR!;
    const a = join(config, "profiles", `a-${failure}`),
      b = join(config, "profiles", `b-${failure}`);
    const rel = join("projects", claudeProjectDirName("/w"));
    const sidecar = join(a, rel, "sid");
    mkdirSync(sidecar, { recursive: true });
    mkdirSync(b, { recursive: true });
    const source = join(a, rel, "sid.jsonl"),
      target = join(b, rel, "sid.jsonl");
    writeFileSync(source, "complete history");
    writeFileSync(join(sidecar, "result.txt"), "tool output");
    if (failure === "size")
      vi.mocked(copyFileSync).mockImplementationOnce((_source, dest) => writeFileSync(dest, "cut"));
    else
      vi.mocked(cpSync).mockImplementationOnce((_source, dest) => {
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(String(dest), "partial.txt"), "partial");
        throw new Error("fixture sidecar failure");
      });
    const moved = await claudeContinuity.move(
      { file: source, sidecars: [sidecar], nativeSessionId: "sid" },
      { CLAUDEXOR_PROFILE_LOCATOR: a },
      { CLAUDEXOR_PROFILE_LOCATOR: b },
      "/w",
    );
    expect(moved.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(b, rel, "sid"))).toBe(false);
    expect(readFileSync(source, "utf8")).toBe("complete history");
    expect(readFileSync(join(sidecar, "result.txt"), "utf8")).toBe("tool output");
  },
);
