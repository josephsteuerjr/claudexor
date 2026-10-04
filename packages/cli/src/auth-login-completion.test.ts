import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlSetupJob, type ControlHarnessSetupHarness } from "@claudexor/schema";
import * as daemonRun from "./daemon-run.js";
import * as live from "./live.js";
import * as inputPrompt from "./setup-login-input-prompt.js";
import { authCommand } from "./ops-commands.js";
import { parseArgs } from "./args.js";
import { streamDurableLogin } from "./setup-login-inline.js";

const addr = { baseUrl: "http://127.0.0.1:1234", token: "fixture-token" };
const time = "2026-10-04T00:00:00Z";
function job(
  harness: ControlHarnessSetupHarness,
  state = "waiting_for_input",
  id = "setup-login-1",
) {
  return ControlSetupJob.parse({
    jobId: id,
    harness,
    action: "login",
    profileId: `${harness}-fixture`,
    state,
    phase: state === "waiting_for_input" ? "awaiting_user" : "completed",
    ...(state === "succeeded" ? { outcome: { reason: "completed" } } : {}),
    command: null,
    guideUrl: null,
    message: `Fixture ${state}`,
    createdAt: time,
    startedAt: time,
    finishedAt: state === "succeeded" ? time : null,
    authCapability: {
      attemptId: "attempt",
      challengeDigest: "a".repeat(64),
      requestDigest: "b".repeat(64),
      state: "disclosed",
      disclosure: {
        schemaVersion: 1,
        protocolVersion: 1,
        harness,
        requested: "subscription",
        requiredRoute: "vendor_native",
        requiredSource: "native_session",
        networkScope: "selected_harness_only",
        billingKnowledge: "unknown",
        incrementalCostKnowledge: "unknown",
        mayConsumeQuota: true,
        generatedAt: time,
      },
    },
  });
}
function snapshot(
  harness: ControlHarnessSetupHarness,
  state = "waiting_for_input",
  tail = "first",
) {
  return {
    job: job(harness, state),
    cursor: "cursor",
    sequence: 1,
    ...(state === "waiting_for_input"
      ? {
          deviceCode: {
            flow: harness === "cursor" ? "oauth_url" : "oauth_url_input",
            verificationUrl: `https://example.invalid/oauth?state=${tail}`,
            userCode: "",
          },
        }
      : {}),
  };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("managed login completion at CLI consumers", () => {
  let output: string[];
  let tty: PropertyDescriptor | undefined;
  beforeEach(() => {
    output = [];
    tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    vi.restoreAllMocks();
  });

  it.each(["claude", "cursor"] as const)(
    "auth login %s follows the actual daemon job",
    async (harness) => {
      vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({ addr } as Awaited<
        ReturnType<typeof daemonRun.ensureDaemon>
      >);
      const prompt = vi.spyOn(inputPrompt, "promptLoginInput").mockResolvedValue("one-time-input");
      let reads = 0;
      const posts: Array<{ path: string; body: unknown }> = [];
      vi.spyOn(live, "controlApiFetch").mockImplementation(async (_address, path, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          posts.push({ path, body });
          return response(job(harness));
        }
        expect(path).toBe("/setup/jobs/setup-login-1/snapshot");
        reads += 1;
        const completed =
          harness === "cursor" ? reads > 1 : posts.some((p) => p.path.endsWith("/input"));
        return response(
          snapshot(
            harness,
            completed ? "succeeded" : "waiting_for_input",
            reads > 1 ? "corrected-complete-link" : "first",
          ),
        );
      });
      expect(await authCommand(parseArgs(["auth", "login", harness]), false)).toBe(0);
      expect(posts.filter((p) => p.path === "/setup/jobs")).toEqual([
        { path: "/setup/jobs", body: { harness, action: "login", authRequest: "subscription" } },
      ]);
      expect(prompt).toHaveBeenCalledTimes(harness === "claude" ? 1 : 0);
      expect(posts.filter((p) => p.path.endsWith("/input"))).toHaveLength(
        harness === "claude" ? 1 : 0,
      );
      const text = output.join("");
      expect(text).toContain("https://example.invalid/oauth");
      expect(text).toContain(`${harness}/`);
      expect(text).toContain("succeeded");
      expect(text).not.toContain("opened Terminal");
      expect(text).not.toContain("OpenAI");
      expect(text).not.toContain("one-time-input");
      if (harness === "claude") expect(text).toContain("corrected-complete-link");
    },
  );

  it("first login waits through launching before opening the real input prompt", async () => {
    const input = new PassThrough();
    const promptOutput = new PassThrough();
    let promptText = "";
    promptOutput.on("data", (chunk) => {
      promptText += String(chunk);
    });
    let reads = 0;
    const submissions: unknown[] = [];
    try {
      const exit = await streamDurableLogin(addr, "setup-login-1", {
        label: "claude",
        isTTY: true,
        sleep: async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
        fetchImpl: async (_path, init) => {
          if (init?.method === "POST") {
            submissions.push(JSON.parse(String(init.body)));
            return response(job("claude"));
          }
          reads += 1;
          if (reads === 1)
            return response({
              ...snapshot("claude", "running"),
              job: { ...job("claude", "running"), phase: "launching" },
            });
          return response(
            snapshot("claude", submissions.length ? "succeeded" : "waiting_for_input"),
          );
        },
        promptInput: (question, signal) => {
          expect(signal.aborted).toBe(false);
          const pending = inputPrompt.promptLoginInput(question, signal, {
            input,
            output: promptOutput,
          });
          input.write("first-login-fixture\n");
          return pending;
        },
      });
      expect(exit).toBe(0);
      expect(promptText).toContain("Paste the sign-in code");
      expect(submissions).toEqual([{ value: "first-login-fixture" }]);
      expect(output.join("")).not.toContain("first-login-fixture");
    } finally {
      input.destroy();
      promptOutput.destroy();
    }
  });

  it("leaving the input phase cancels its reader without reporting a user refusal", async () => {
    const input = new PassThrough();
    const promptOutput = new PassThrough();
    let reads = 0;
    let posts = 0;
    try {
      const exit = await streamDurableLogin(addr, "setup-login-1", {
        label: "claude",
        isTTY: true,
        sleep: async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
        fetchImpl: async (_path, init) => {
          if (init?.method === "POST") posts += 1;
          reads += 1;
          if (reads === 2)
            return response({
              ...snapshot("claude", "running"),
              job: { ...job("claude", "running"), phase: "verifying" },
            });
          return response(snapshot("claude", reads > 2 ? "succeeded" : "waiting_for_input"));
        },
        promptInput: (question, signal) =>
          inputPrompt.promptLoginInput(question, signal, { input, output: promptOutput }),
      });
      expect(exit).toBe(0);
      expect(posts).toBe(0);
      expect(output.join("")).not.toContain("No code was submitted");
      expect(input.listenerCount("data")).toBe(0);
    } finally {
      input.destroy();
      promptOutput.destroy();
    }
  });

  it("JSON discloses the same input job and endpoint without reading or submitting a code", async () => {
    const prompt = vi.fn();
    const fetchImpl = vi.fn(async () => response(snapshot("claude")));
    expect(
      await streamDurableLogin(addr, "setup-login-1", {
        label: "claude",
        json: true,
        fetchImpl,
        promptInput: prompt,
      }),
    ).toBe(0);
    const result = JSON.parse(output.join(""));
    expect(result.job.state).toBe("waiting_for_input");
    expect(result.nextAction).toEqual({
      kind: "submit_sign_in_input",
      method: "POST",
      path: "/v2/setup/jobs/setup-login-1/input",
      jobId: "setup-login-1",
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("non-TTY names the still-active job and continuation without waiting for input", async () => {
    const prompt = vi.fn();
    expect(
      await streamDurableLogin(addr, "setup-login-1", {
        label: "claude",
        isTTY: false,
        promptInput: prompt,
        resumeCommand: "claudexor auth login claude",
        fetchImpl: async () => response(snapshot("claude")),
      }),
    ).toBe(1);
    expect(output.join("")).toContain("claudexor auth login claude");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("keeps polling while code input is pending and aborts the prompt on terminal", async () => {
    let reads = 0;
    let inputSignal: AbortSignal | undefined;
    const promptInput = (_question: string, signal: AbortSignal) => {
      inputSignal = signal;
      return new Promise<string | null>((resolve) =>
        signal.addEventListener("abort", () => resolve(null)),
      );
    };
    expect(
      await streamDurableLogin(addr, "setup-login-1", {
        label: "claude",
        isTTY: true,
        promptInput,
        sleep: async () => {},
        fetchImpl: async () =>
          response(snapshot("claude", ++reads > 1 ? "succeeded" : "waiting_for_input")),
      }),
    ).toBe(0);
    expect(inputSignal?.aborted).toBe(true);
    expect(reads).toBe(2);
  });

  it("never submits to a snapshot for another job", async () => {
    const prompt = vi.fn();
    await expect(
      streamDurableLogin(addr, "setup-requested", {
        label: "claude",
        isTTY: true,
        promptInput: prompt,
        fetchImpl: async () => response(snapshot("claude")),
      }),
    ).rejects.toThrow("does not match");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("a previously delivered code is not replaced or retried after the server's typed reply", async () => {
    let posts = 0;
    const prompt = vi.fn(async () => "second-value");
    expect(
      await streamDurableLogin(addr, "setup-login-1", {
        label: "claude",
        isTTY: true,
        promptInput: prompt,
        sleep: async () => {},
        fetchImpl: async (_path, init) => {
          if (init?.method === "POST") {
            posts += 1;
            return response({ code: "setup_input_already_submitted" }, 409);
          }
          return response(snapshot("claude", posts ? "succeeded" : "waiting_for_input"));
        },
      }),
    ).toBe(0);
    expect(posts).toBe(1);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(output.join("")).toContain("already submitted");
    expect(output.join("")).not.toContain("second-value");
  });
});
