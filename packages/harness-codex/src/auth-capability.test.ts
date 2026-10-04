import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { spawnProcess } from "@claudexor/core";
import type { HarnessEvent } from "@claudexor/schema";
import { AuthCapabilityVerifier } from "../../core/src/auth-capability-verifier.js";
import { runCodexAppServer } from "./app-server-run.js";
import { clearCodexEffortCache, createCodexAdapter } from "./index.js";

it("verifies default-store Codex auth after the native adapter's effort preparation receipt", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-authcap-")));
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", root);
  vi.stubEnv("CLAUDEXOR_CODEX_NATIVE_HOME", undefined);
  vi.stubEnv("CLAUDEXOR_CODEX_MODEL", undefined);
  clearCodexEffortCache();
  const events: HarnessEvent[] = [];
  const methods: string[] = [];
  const probeLogin = vi.fn(async () => ({
    authed: true,
    method: "chatgpt" as const,
    probeError: null,
  }));
  const probeEfforts = vi.fn(async () => ({
    models: { fixture: { levels: ["low", "high"], default: "low" } },
    defaultModel: "fixture",
  }));
  const transport = vi.fn();
  const unexpectedCredential = vi.fn(() => {
    throw new Error("capability smoke must use the injected default native-session probe");
  });
  try {
    const adapter = createCodexAdapter({
      probeLogin,
      probeEfforts,
      codexApiKey: unexpectedCredential,
      resolveProfileSecret: unexpectedCredential,
      runAppServer: (input) => {
        transport(input);
        expect(input.spec).toMatchObject({
          auth_preference: "subscription",
          credential_profile: null,
          effort_hint: null,
          access: "readonly",
          env_inheritance: "clean",
          evidence_policy: "stream_only",
        });
        expect(input.env.CODEX_HOME).toBe(join(root, "native", "codex"));
        const challenge = /^Return exactly (\S+) and no other text\./.exec(input.spec.prompt)?.[1];
        if (!challenge) throw new Error("missing capability challenge");
        const replies: string[] = [];
        let wake: (() => void) | undefined;
        let stopped = false;
        const push = (frame: unknown): void => {
          replies.push(JSON.stringify(frame));
          wake?.();
          wake = undefined;
        };
        const stop = (): void => {
          stopped = true;
          wake?.();
        };
        // Keep the production JSON-RPC lifecycle, parser, and decoration; only
        // the native process I/O is in-memory.
        const spawn: typeof spawnProcess = async function* (_bin, args, options = {}) {
          expect(args.slice(-2)).toEqual(["app-server", "--stdio"]);
          options.onSpawn?.({
            write(data) {
              const request = JSON.parse(data) as {
                id?: number;
                method: string;
                params?: Record<string, unknown>;
              };
              methods.push(request.method);
              const respond = (result: unknown): void => push({ id: request.id, result });
              switch (request.method) {
                case "initialize":
                  respond({});
                  break;
                case "initialized":
                  break;
                case "thread/start":
                  expect(request.params?.config).not.toHaveProperty("model_reasoning_effort");
                  respond({ thread: { id: "native-codex-smoke" } });
                  break;
                case "turn/start":
                  respond({ turn: { id: "turn-smoke" } });
                  push({
                    method: "turn/started",
                    params: { threadId: "native-codex-smoke", turn: { id: "turn-smoke" } },
                  });
                  push({
                    method: "item/completed",
                    params: {
                      item: { type: "agentMessage", id: "smoke-answer", text: challenge },
                    },
                  });
                  push({
                    method: "turn/completed",
                    params: { turn: { id: "turn-smoke", status: "completed" } },
                  });
                  break;
                case "thread/read":
                  respond({ thread: { status: { type: "idle" } } });
                  break;
                case "thread/goal/get":
                  respond({ goal: null });
                  break;
                case "thread/backgroundTerminals/list":
                  respond({ data: [] });
                  break;
                default:
                  throw new Error(`unexpected fixture RPC ${request.method}`);
              }
            },
            end: stop,
            closed: Promise.resolve(),
          });
          options.abortSignal?.addEventListener("abort", stop, { once: true });
          try {
            yield {
              type: "launch_advisory",
              detail: "Using the working fallback; preferred entry is broken",
            };
            while (!stopped) {
              if (replies.length) yield { type: "stdout", line: replies.shift()! };
              else await new Promise<void>((resolve) => (wake = resolve));
            }
          } finally {
            options.abortSignal?.removeEventListener("abort", stop);
          }
        };
        return runCodexAppServer({ ...input, spawn });
      },
    });
    const verifier = new AuthCapabilityVerifier(
      (id) =>
        id === adapter.id
          ? {
              ...adapter,
              async *run(spec) {
                for await (const event of adapter.run(spec)) {
                  events.push(event);
                  yield event;
                }
              },
            }
          : undefined,
      { scratchRoot: join(root, "smokes") },
    );
    const { binding } = verifier.prepare({
      attemptId: "codex-default-store",
      harness: "codex",
      requested: "subscription",
      requiredRoute: "vendor_native",
      requiredSource: "native_session",
    });
    const receipt = await verifier.verify({ binding, startedAt: new Date().toISOString() });

    expect(probeLogin).toHaveBeenCalledTimes(1);
    expect(probeEfforts).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(unexpectedCredential).not.toHaveBeenCalled();
    expect(methods).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "thread/read",
      "thread/goal/get",
      "thread/backgroundTerminals/list",
    ]);
    expect(events[0]).toMatchObject({
      type: "status",
      session_id: "auth-smoke-codex-default-store",
      effort_resolution: {
        requested: null,
        submitted: null,
        parameter: "model_reasoning_effort",
        observed: null,
        observedSource: null,
        resolution: "omitted",
        source: "live_probe",
      },
    });
    expect(events[0]).not.toHaveProperty("text");
    expect(events[1]).toMatchObject({
      type: "started",
      credential_route: "vendor_native",
      credential_source: "native_session",
      payload: { native_session_id: "native-codex-smoke", native_turn_id: "turn-smoke" },
    });
    expect(events[2]).toMatchObject({
      type: "status",
      text: "Using the working fallback; preferred entry is broken",
      payload: { launch_advisory: true },
    });
    expect(events.some((event) => event.type === "message" && event.final === true)).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
    expect(receipt).toMatchObject({
      verification: "passed",
      availability: "available",
      effective: "vendor_native",
      effectiveSource: "native_session",
      selectionReason: "exact_requested_route",
      responseDigest: binding.challengeDigest,
      scratchBeforeDigest: receipt.scratchAfterDigest,
    });
  } finally {
    clearCodexEffortCache();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
