import type { SpawnOptions } from "@claudexor/core";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_AUTH_REFRESH_TERMINATION_UNCONFIRMED,
  CLAUDE_OAUTH_REFRESH_SKEW_MS,
  claudeOauthAccessTokenIsFresh,
  refreshClaudeNativeAuth,
} from "./auth-refresh.js";

describe("Claude native OAuth refresh wake", () => {
  it("uses the vendor five-minute refresh window", () => {
    const now = Date.parse("2026-08-30T07:00:00Z");
    expect(claudeOauthAccessTokenIsFresh(null, now)).toBe(false);
    expect(claudeOauthAccessTokenIsFresh(now + CLAUDE_OAUTH_REFRESH_SKEW_MS, now)).toBe(false);
    expect(claudeOauthAccessTokenIsFresh(now + CLAUDE_OAUTH_REFRESH_SKEW_MS + 1, now)).toBe(true);
  });

  it("holds a prompt-free vendor MCP process until expiry metadata advances", async () => {
    const diagnostics: unknown[] = [];
    let captured:
      | {
          cmd: string;
          args: string[];
          options: SpawnOptions;
        }
      | undefined;
    let stdinEnded = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const spawn = async function* (cmd: string, args: string[], options: SpawnOptions = {}) {
      captured = { cmd, args, options };
      options.onSpawn?.({
        write: () => {},
        end: () => {
          stdinEnded = true;
          resolveClosed();
        },
        closed,
      });
      await closed;
      yield { type: "exit" as const, code: 0, signal: null };
    };
    const now = Date.parse("2026-08-30T07:00:00Z");
    const expiries = [now - 1, now + 8 * 60 * 60_000];

    const refreshed = await refreshClaudeNativeAuth(
      { CLAUDE_CONFIG_DIR: "/profiles/claude-a", ANTHROPIC_API_KEY: null },
      async () => expiries.shift() ?? null,
      {
        spawn: spawn as typeof import("@claudexor/core").spawnProcess,
        nowMs: () => now,
        sleep: async () => {},
        bin: "/vendor/claude",
        cwd: process.cwd(),
        diagnostic: (record) => diagnostics.push(record),
      },
    );

    expect(refreshed).toBe(true);
    expect(captured?.cmd).toBe("/vendor/claude");
    expect(captured?.args).toEqual(["--setting-sources", "", "mcp", "serve"]);
    expect(captured?.args).not.toContain("-p");
    expect(captured?.options.input).toBeUndefined();
    expect(captured?.options.keepStdinOpen).toBe(true);
    expect(captured?.options.env).toMatchObject({
      CLAUDE_CONFIG_DIR: "/profiles/claude-a",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    });
    expect(stdinEnded).toBe(true);
    expect(captured?.options.abortSignal?.aborted).toBe(false);
    expect(diagnostics).toEqual([
      {
        binary: null,
        expiresAtMs: now + 8 * 60 * 60_000,
        exitCode: 0,
        signal: null,
        terminationUnconfirmed: false,
        childFailed: false,
      },
    ]);
  });

  it("returns false and reaps the exact child when it exits before refreshing", async () => {
    let stdinEnded = false;
    const spawn = async function* (_cmd: string, _args: string[], options: SpawnOptions = {}) {
      options.onSpawn?.({
        write: () => {},
        end: () => {
          stdinEnded = true;
        },
        closed: Promise.resolve(),
      });
      yield { type: "exit" as const, code: 1, signal: null };
    };

    const refreshed = await refreshClaudeNativeAuth({}, async () => 0, {
      spawn: spawn as typeof import("@claudexor/core").spawnProcess,
      nowMs: () => 10_000,
      sleep: async () => {},
      cwd: process.cwd(),
    });

    expect(refreshed).toBe(false);
    expect(stdinEnded).toBe(false);
  });

  it("bounds a silent helper and aborts it after the refresh deadline", async () => {
    let aborted = false;
    let stdinEnded = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const spawn = async function* (_cmd: string, _args: string[], options: SpawnOptions = {}) {
      options.onSpawn?.({
        write: () => {},
        end: () => {
          stdinEnded = true;
        },
        closed,
      });
      await new Promise<void>((resolve) => {
        options.abortSignal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolveClosed();
            resolve();
          },
          { once: true },
        );
      });
      yield { type: "exit" as const, code: null, signal: "SIGTERM" as const };
    };
    const times = [0, 0, 20_001];

    const refreshed = await refreshClaudeNativeAuth({}, async () => 0, {
      spawn: spawn as typeof import("@claudexor/core").spawnProcess,
      nowMs: () => times.shift() ?? 20_001,
      sleep: async () => {},
      cwd: process.cwd(),
      timeoutMs: 20_000,
    });

    expect(refreshed).toBe(false);
    expect(stdinEnded).toBe(true);
    expect(aborted).toBe(true);
  });

  it("fails closed when the helper process tree cannot be proven dead", async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const spawn = async function* (_cmd: string, _args: string[], options: SpawnOptions = {}) {
      options.onSpawn?.({ write: () => {}, end: () => {}, closed });
      await new Promise<void>((resolve) => {
        options.abortSignal?.addEventListener(
          "abort",
          () => {
            resolveClosed();
            resolve();
          },
          { once: true },
        );
      });
      yield { type: "exit" as const, code: null, signal: "SIGTERM" as const };
      yield {
        type: "termination_unconfirmed" as const,
        rootPid: 42,
        survivors: [43],
        unresolved: [],
      };
    };
    const now = Date.parse("2026-08-30T07:00:00Z");

    await expect(
      refreshClaudeNativeAuth({}, async () => now + 8 * 60 * 60_000, {
        spawn: spawn as typeof import("@claudexor/core").spawnProcess,
        nowMs: () => now,
        sleep: async () => {},
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({
      code: CLAUDE_AUTH_REFRESH_TERMINATION_UNCONFIRMED,
      message: expect.stringContaining("termination could not be confirmed"),
    });
  });
});
