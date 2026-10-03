import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDEXOR_VERSION } from "@claudexor/util";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  controlApiFetch: vi.fn(),
}));

// Partial mocks (spread the real module) so the wide ops-commands import graph
// keeps every other export intact — only the daemon seam is stubbed.
vi.mock("./daemon-run.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureDaemon: mocks.ensureDaemon,
}));
vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  controlApiFetch: mocks.controlApiFetch,
}));

import { parseArgs } from "./args.js";
import { gcCommand } from "./ops-commands.js";

/** Minimal receipt the pre-feature shape allows: no data_root_unrecognized. */
const RECEIPT = {
  schema_version: 1,
  dry_run: false,
  started_at: "2026-08-08T00:00:00.000Z",
  finished_at: "2026-08-08T00:00:01.000Z",
  policy: { runs_max_age_days: 30, reviews_max_age_days: 14, keep_last_runs_per_project: 1 },
  examined_runs: 0,
  deleted_runs: [],
  kept: {},
  deleted_reviews: [],
  freed_bytes: 0,
  errors: [],
};

function engine(version: string | null): { engineVersion: string | null; engineBuildSha: null } {
  return { engineVersion: version, engineBuildSha: null };
}

function sentBody(): Record<string, unknown> {
  const init = mocks.controlApiFetch.mock.calls[0]?.[2] as { body?: string } | undefined;
  expect(init?.body).toBeTypeOf("string");
  return JSON.parse(init!.body!) as Record<string, unknown>;
}

describe("gcCommand data_root_report capability negotiation", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.controlApiFetch.mockResolvedValue(
      new Response(JSON.stringify(RECEIPT), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("sends the opt-in report flags ONLY to a lockstep same-version daemon", async () => {
    mocks.ensureDaemon.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
      engine: engine(CLAUDEXOR_VERSION),
    });
    expect(await gcCommand(parseArgs(["gc", "--dry-run"]), true)).toBe(0);
    expect(sentBody()).toEqual({ dry_run: true, data_root_report: true, trash_purge_report: true });
  });

  it("prints the thread purges a lockstep receipt discloses", async () => {
    mocks.ensureDaemon.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
      engine: engine(CLAUDEXOR_VERSION),
    });
    mocks.controlApiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...RECEIPT,
          dry_run: true,
          purged_threads: ["th-1", "th-2"],
          purge_leftovers: ["th-0"],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    expect(await gcCommand(parseArgs(["gc", "--dry-run"]), false)).toBe(0);
    const out = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(out).toContain("would purge 2 expired trash thread(s): th-1, th-2");
    expect(out).toContain("would finish 1 purge(s) whose cleanup failed earlier: th-0");
  });

  it("prints no trash line when the receipt omits the opt-in field", async () => {
    mocks.ensureDaemon.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
      engine: engine("0.0.1"),
    });
    expect(await gcCommand(parseArgs(["gc"]), false)).toBe(0);
    const out = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(out).not.toContain("expired trash");
    expect(out).not.toContain("cleanup failed earlier");
  });

  it("omits the flag on engine-version skew (exact 3.3.11 request shape)", async () => {
    mocks.ensureDaemon.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
      engine: engine("0.0.1"),
    });
    expect(await gcCommand(parseArgs(["gc"]), true)).toBe(0);
    expect(sentBody()).toEqual({ dry_run: false });
  });

  it("omits the flag when the handshake reported no well-formed engine version", async () => {
    mocks.ensureDaemon.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
      engine: engine(null),
    });
    expect(await gcCommand(parseArgs(["gc"]), true)).toBe(0);
    expect(sentBody()).toEqual({ dry_run: false });
  });
});
