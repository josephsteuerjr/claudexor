import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  HarnessRunSpec,
  RunTelemetry,
  TaskContract,
  SCHEMA_VERSION,
  HarnessEvent,
} from "@claudexor/schema";
import { createCodexAdapter, clearCodexEffortCache } from "../../harness-codex/src/index.js";
import { readModelListEfforts } from "../../harness-codex/src/effort-probe.js";
import { createClaudeAdapter } from "../../harness-claude/src/index.js";
import { createAttemptTelemetry, observeAttemptTelemetry } from "./attemptTelemetry.js";
import { writeRunTelemetryArtifact } from "./runTelemetryWriter.js";
import effortFixture from "../../schema/fixtures/effort-resolution.json" with { type: "json" };

function persist(events: HarnessEvent[], harnessId: string) {
  const root = mkdtempSync(join(tmpdir(), "effort-artifact-"));
  try {
    const store = new ArtifactStore(root, { claudexorDir: root });
    const paths = store.createRun("run");
    const telemetry = createAttemptTelemetry("off", false);
    for (const event of events) observeAttemptTelemetry(telemetry, event);
    writeRunTelemetryArtifact({
      store,
      finalDir: paths.finalDir,
      contract: TaskContract.parse({
        schema_version: SCHEMA_VERSION,
        task_id: "task",
        created_at: new Date(0).toISOString(),
        repo: { root, base_ref: "main" },
        mode: { kind: "ask" },
        user_intent: { raw: "fixture" },
      }),
      runId: "run",
      taskId: "task",
      mode: "ask",
      finalAttemptId: "attempt",
      attempts: [{ attemptId: "attempt", harnessId, telemetry }],
      resolveAuthPreference: () => "auto",
    });
    return RunTelemetry.parse(store.readYaml(join(paths.finalDir, "telemetry.yaml")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("round-trips the canonical contract fixture through final telemetry without retaining an earlier observation", () => {
  const event = { type: "status", session_id: "fixture", ts: new Date(0).toISOString() };
  // Synthetic wire fixtures test the consumer independently of native producers.
  const events = [
    HarnessEvent.parse({
      ...event,
      effort_resolution: { ...effortFixture, observed: "high", observedSource: "fixture.echo" },
    }),
    HarnessEvent.parse({ ...event, effort_resolution: effortFixture }),
  ];
  expect(persist(events, "codex").attempts[0]?.effort_resolution).toEqual(effortFixture);
});

it.each([{ requested: "future", submitted: "future", resolution: "exact" }, effortFixture])(
  "keeps $requested through preflight and persists final native evidence",
  async (expected) => {
    clearCodexEffortCache();
    let sent: string[] = [];
    const adapter = createCodexAdapter({
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () => ({
        defaultModel: "target",
        models: {
          target: { levels: ["low", "xhigh", "future"], default: "low" },
          sibling: { levels: ["low", "xhigh", "ultra", "future"], default: "low" },
        },
      }),
      runCliHarness: async function* (opts) {
        sent = opts.args;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: new Date(0).toISOString(),
        };
      },
    });
    // Preflight carries the preference to the route unchanged — discovery only
    // describes the default account — so the spec holds exactly what was asked.
    const spec = HarnessRunSpec.parse({
      session_id: "session",
      intent: "explain",
      cwd: process.cwd(),
      prompt: "fixture",
      model_hint: "target",
      effort_hint: expected.requested,
    });
    const events = [];
    for await (const event of adapter.run(spec)) events.push(event);
    expect(sent).toContain(`model_reasoning_effort="${expected.submitted}"`);
    expect(persist(events, "codex").attempts[0]?.effort_resolution).toEqual({
      ...expected,
      source: "live_probe",
      parameter: "model_reasoning_effort",
      observed: null,
      observedSource: null,
    });
    expect(events.some((event) => event.type === "message")).toBe(false);
    clearCodexEffortCache();
  },
);

it("uses Claude's known vendor order below a missing level, logs it, and persists it in final telemetry", async () => {
  let sent: string[] = [];
  const adapter = createClaudeAdapter({
    probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
    probeAuthStatus: async () => ({
      loggedIn: true,
      authed: true,
      authMethod: "claude.ai",
      probeError: null,
    }),
    anthropicApiKey: () => null,
    claudeOAuthToken: () => null,
    probeEffortLevels: async () => ({ levels: ["low", "max"], live: true }),
    runCliHarness: async function* (opts) {
      sent = opts.args;
      yield { type: "completed", session_id: opts.spec.session_id, ts: new Date(0).toISOString() };
    },
  });
  const spec = HarnessRunSpec.parse({
    session_id: "session",
    intent: "explain",
    cwd: process.cwd(),
    prompt: "fixture",
    effort_hint: "xhigh",
  });
  const events = [];
  for await (const event of adapter.run(spec)) events.push(event);
  expect(sent[sent.indexOf("--effort") + 1]).toBe("low");
  expect(persist(events, "claude").attempts[0]).toMatchObject({
    effort_resolution: {
      requested: "xhigh",
      submitted: "low",
      resolution: "downward",
      parameter: "--effort",
      observed: null,
    },
  });
  expect(events.some((event) => event.type === "message")).toBe(false);
});

it.each([true, false])(
  "distinguishes known empty capability from unverifiable proof (live=%s)",
  async (live) => {
    let sent: string[] = [];
    const adapter = createClaudeAdapter({
      detectVersion: async () => "0.0.0",
      probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
      probeAuthStatus: async () => ({
        loggedIn: true,
        authed: true,
        authMethod: "claude.ai",
        probeError: null,
      }),
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
      probeEffortLevels: async () => ({ levels: live ? [] : ["low", "high"], live }),
      runCliHarness: async function* (opts) {
        sent = opts.args;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: new Date(0).toISOString(),
        };
      },
    });
    const spec = HarnessRunSpec.parse({
      session_id: "session",
      intent: "explain",
      cwd: process.cwd(),
      prompt: "fixture",
      effort_hint: "high",
    });
    const events = [];
    for await (const event of adapter.run(spec)) events.push(event);
    expect(sent).not.toContain("--effort");
    expect(persist(events, "claude").attempts[0]).toMatchObject({
      effort_resolution: {
        requested: "high",
        submitted: null,
        resolution: live ? "omitted" : "unverifiable",
        source: live ? "live_probe" : "adapter",
        observed: null,
      },
    });
  },
);

it("records omission for a carrier-less route without rewriting its compound model", async () => {
  const { runModelGovernedRoute } = await import("./modelGovernance.js");
  const slug = "cursor-grok-4.6-xhigh";
  let observedSpec: HarnessRunSpec | undefined;
  const adapter = {
    id: "compound",
    discover: async () => {
      throw new Error("unneeded discovery");
    },
    doctor: async () => {
      throw new Error("unneeded doctor");
    },
    run: async function* (spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      observedSpec = spec;
      yield { type: "completed", session_id: spec.session_id, ts: new Date(0).toISOString() };
    },
  };
  const spec = HarnessRunSpec.parse({
    session_id: "compound",
    intent: "explain",
    cwd: process.cwd(),
    prompt: "fixture",
    model_hint: slug,
    effort_hint: "low",
  });
  const events = [];
  for await (const event of runModelGovernedRoute(
    {
      adapter,
      knownModels: [slug],
      authRouteEstimate: null,
      quotaAdmission: { profile: null },
      settings: null,
    },
    spec,
  ))
    events.push(event);
  expect(observedSpec?.model_hint).toBe(slug);
  expect(persist(events, "compound").attempts[0]).toMatchObject({
    effort_resolution: {
      requested: "low",
      submitted: null,
      resolution: "omitted",
      source: "adapter",
      parameter: null,
      observed: null,
      observedSource: null,
    },
  });
});

it.each([true, false])(
  "keeps explicit empty versus missing native model effort metadata (empty=%s)",
  async (empty) => {
    clearCodexEffortCache();
    let sent: string[] = [];
    const adapter = createCodexAdapter({
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () =>
        readModelListEfforts([
          { id: "target", isDefault: true, ...(empty ? { supportedReasoningEfforts: [] } : {}) },
          {
            id: "sibling",
            supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
          },
        ]),
      runCliHarness: async function* (opts) {
        sent = opts.args;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: new Date(0).toISOString(),
        };
      },
    });
    const spec = HarnessRunSpec.parse({
      session_id: "session",
      intent: "explain",
      cwd: process.cwd(),
      prompt: "fixture",
      model_hint: "target",
      effort_hint: "high",
    });
    const events = [];
    for await (const event of adapter.run(spec)) events.push(event);
    expect(sent.some((arg) => arg.startsWith("model_reasoning_effort="))).toBe(false);
    expect(persist(events, "codex").attempts[0]?.effort_resolution).toMatchObject({
      requested: "high",
      submitted: null,
      resolution: empty ? "omitted" : "unverifiable",
      observed: null,
      observedSource: null,
    });
    clearCodexEffortCache();
  },
);
