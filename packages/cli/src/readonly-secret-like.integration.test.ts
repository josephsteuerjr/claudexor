import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { Orchestrator, type RunInput } from "@claudexor/orchestrator";
import { ConformanceReport, HarnessManifest, McpRunHandleResult } from "@claudexor/schema";
import { containsSecretLikeToken } from "@claudexor/util";
import { projectRecoveryRunDetail } from "./mcp-run-projections.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function harness(id: string, reply: string, narration: string): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: id === "reader-one" ? "cursor" : "anthropic",
        capabilities: {
          plan: true,
          synthesize: true,
          read_files: true,
          work_report_transport: "validated",
        },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["explain", "audit", "plan", "synthesize"],
      });
    },
    async *run(spec) {
      const base = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...base, type: "started", credential_route: "vendor_native" };
      yield { ...base, type: "message", text: narration };
      yield { ...base, type: "message", text: reply, payload: { delta: true } };
      yield { ...base, type: "message", text: reply, final: true };
      yield { ...base, type: "completed" };
    },
  };
}

async function readOnlyRun(input: Partial<RunInput>, secretOutput: boolean) {
  const repo = mkdtempSync(join(tmpdir(), "readonly-disclosure-"));
  roots.push(repo);
  // Build fake credentials only at runtime; never store a secret-shaped literal.
  const secret = ["sk", "a".repeat(24)].join("-");
  const reply = secretOutput ? `Keep this answer: ${secret} and ${secret}.` : "An ordinary answer.";
  const adapters = ["reader-one", "reader-two"].map((id) =>
    harness(id, reply, `Discarded narration: ${secret} ${secret} ${secret}`),
  );
  const result = await new Orchestrator({
    registry: new Map(adapters.map((adapter) => [adapter.id, adapter])),
    reviewers: [],
  }).run({
    repoRoot: repo,
    prompt: "Explain the proposed approach.",
    harnesses: adapters.map((adapter) => adapter.id),
    mode: "ask",
    ...input,
  });
  expect(result.lifecycle, result.summary).toBe("succeeded");
  const store = new ArtifactStore(repo);
  const workProduct = store.readYaml(join(result.runDir, "final/work_product.yaml")) as {
    meta: Record<string, unknown>;
    producer_attempt_id: string;
  };
  const path = `final/${input.mode === "plan" ? "plan" : input.deepScan ? "report" : "answer"}.md`;
  const output = readFileSync(join(result.runDir, path), "utf8");
  const summary = readFileSync(join(result.runDir, "final/summary.md"), "utf8");
  const detail = {
    summary: { runId: result.runId, runDir: result.runDir, state: result.lifecycle },
    outcomeFacts: result.facts,
    workProduct,
    finalSummary: summary,
    primaryOutput: { kind: input.mode === "plan" ? "plan" : "report", path, text: output },
  };
  for (const text of [
    output,
    summary,
    JSON.stringify(workProduct),
    readFileSync(join(result.runDir, "events.jsonl"), "utf8"),
  ]) {
    expect(containsSecretLikeToken(text)).toBe(false);
    expect(text.includes(secret)).toBe(false);
  }
  return { result, output, summary, workProduct, detail };
}

describe("read-only secret-like disclosure from raw events through artifacts to MCP", () => {
  it.each([
    { mode: "ask" as const },
    { mode: "plan" as const },
    { mode: "ask" as const, deepScan: true, n: 1 },
    { mode: "ask" as const, deepScan: true, n: 2 },
    { mode: "plan" as const, council: true, n: 2 },
  ])("keeps and discloses the selected answer for %j", async (input) => {
    const run = await readOnlyRun(input, true);
    expect(run.workProduct.producer_attempt_id).toBe(
      input.mode === "plan"
        ? "council" in input
          ? "p03"
          : "p01"
        : "deepScan" in input && input.n === 2
          ? "synth"
          : "a01",
    );
    expect(run.output).toContain("Keep this answer: [redacted] and [redacted].");
    expect
      .soft(run.workProduct.meta["secret_like"])
      .toMatchObject({ answer_matches: 2, total_matches: 2 });
    expect.soft(run.summary).toContain("2 hidden in the answer");
    for (const mode of ["__run_result", "__run_status"]) {
      const projected = McpRunHandleResult.parse(
        projectRecoveryRunDetail(mode, run.result.runId, run.detail),
      );
      expect.soft(projected.secretLike).toEqual({
        answerMatches: 2,
        totalMatches: 2,
        files: [],
        binaryPaths: [],
        mediaWithheld: [],
        persistedPatch: "exact",
        exactPatchRecorded: null,
      });
    }
  });

  it.each(["ask", "plan"] as const)(
    "%s: a clean final supersedes discarded narration counts",
    async (mode) => {
      const run = await readOnlyRun({ mode }, false);
      expect(run.workProduct.meta["secret_like"]).toBeUndefined();
      expect(run.summary).not.toContain("Secret-like strings:");
      expect(
        projectRecoveryRunDetail("__run_result", run.result.runId, run.detail)["secretLike"],
      ).toBeNull();
    },
  );
});
