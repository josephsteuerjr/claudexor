import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { launchDetachedDaemon } from "./daemon-launch.js";

vi.mock("@claudexor/util", async (original) => {
  const util = await original<typeof import("@claudexor/util")>();
  return {
    ...util,
    daemonHeapLaunch: (env: NodeJS.ProcessEnv) =>
      util.selectDaemonHeap({
        constrainedMemoryBytes: 0,
        physicalMemoryBytes: 128 * 2 ** 30,
        defaultHeapLimitBytes: 4 * 2 ** 30,
        nodeOptions: env.NODE_OPTIONS,
      }),
  };
});
afterEach(() => vi.unstubAllEnvs());

it.each([undefined, "--max-old-space-size=2048"])(
  "passes heap argv before entry and honors the child's NODE_OPTIONS=%s",
  async (nodeOptions) => {
    const root = mkdtempSync(join(tmpdir(), "cx-heap-launch-"));
    const entry = join(root, "capture.mjs");
    const receipt = join(root, "argv.json");
    writeFileSync(
      entry,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({argv:process.execArgv, options:process.env.NODE_OPTIONS ?? null}));`,
    );
    // Ambient options are deliberately different: only the passed child env wins.
    vi.stubEnv("NODE_OPTIONS", nodeOptions ? "" : "--max-old-space-size=2048");
    try {
      const launch = launchDetachedDaemon({
        entryPath: entry,
        launchSource: "cli_explicit_start",
        env: { ...process.env, NODE_OPTIONS: nodeOptions },
      });
      expect(await launch.waitForFailure()).toMatchObject({ kind: "preclaim_exit", exitCode: 0 });
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({
        argv: nodeOptions ? [] : ["--max-old-space-size=16384"],
        options: nodeOptions ?? null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
