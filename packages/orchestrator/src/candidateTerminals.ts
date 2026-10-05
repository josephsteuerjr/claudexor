import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import type { BudgetLedger } from "@claudexor/budget";
import { makeOutcomeFacts, type ModeKind } from "@claudexor/schema";
import type { OrchestratorResult } from "./orchestrator.js";
import {
  partitionCandidates,
  unanimousDeclaredFailure,
  type CandidateRun,
} from "./candidateEvidence.js";
import { publishDirectoryCandidate } from "./directoryCandidate.js";
import * as secretDiff from "./secretDiff.js";
import { classifyBudgetFailure, budgetFailureRecord, type BudgetDenial } from "./budgetFailure.js";
import { writeFailure } from "./runTerminalResults.js";
import { decisionBudgetSummary } from "./decisionBudget.js";
import {
  attemptVendorFailure,
  dominantHarnessFailureCategory,
  harnessFailureNextActions,
} from "./harnessFailure.js";
import { cancelledResult } from "./runTerminals.js";
import { gatesPassed } from "@claudexor/review";
import { publishUnverifiedGitCandidate } from "./candidateWorkProduct.js";

interface CandidateTerminalContext {
  ledger: BudgetLedger;
  mode: ModeKind;
  store: ArtifactStore;
  paths: RunPaths;
  log: EventLog;
  runId: string;
  taskId: string;
}

export async function cancelledCandidatesResult(
  input: CandidateTerminalContext & {
    runs: CandidateRun[];
    signal?: AbortSignal;
    writeTelemetry(): void;
    git?: {
      live: boolean;
      execRoot: string;
      preTurnSha: string | null;
      postTurnSha: string | null;
    };
  },
): Promise<OrchestratorResult> {
  const { store, paths, log, runId, taskId, mode, ledger, runs, signal, writeTelemetry } = input;
  const candidate = runs.find((run) => run.files);
  if (candidate?.files)
    await publishDirectoryCandidate({
      files: candidate.files,
      store,
      paths,
      taskId,
      attemptId: candidate.attemptId,
      harnessId: candidate.harnessId,
      facts: makeOutcomeFacts("cancelled", { noChanges: candidate.files.noChanges }),
      log,
    });
  if (runs.length === 1 && input.git) {
    await publishUnverifiedGitCandidate({
      ...input.git,
      run: runs[0]!,
      store,
      paths,
      log,
      taskId,
      mode,
      kind: "patch",
      facts: makeOutcomeFacts("cancelled", { noChanges: !runs[0]!.diff.trim() }),
    });
  } else if (runs.some((run) => run.diff.trim() && !run.captureRefusal)) {
    const patches = runs.filter((run) => run.diff.trim() && !run.captureRefusal);
    store.writeText(
      join(paths.finalDir, "retained-changes.md"),
      "# Unverified candidate changes\n\nNo candidate was selected or applied.\n\n" +
        patches
          .map(
            (run) =>
              `- [${run.attemptId} · ${run.harnessId}](../attempts/${run.attemptId}/patch.diff)`,
          )
          .join("\n"),
    );
    log.emit("output.ready", {
      kind: "report",
      path: "final/retained-changes.md",
      state: "diagnostic",
    });
  }
  return cancelledResult(
    log,
    runId,
    taskId,
    mode,
    paths.root,
    runs.map((run) => ({
      attemptId: run.attemptId,
      harnessId: run.harnessId,
      status: gatesPassed(run.gates) && !run.errored ? "green" : "red",
    })),
    writeTelemetry,
    ledger.spend(),
    signal,
    store,
  );
}

/** No candidate reached execution: preserve the original typed budget/executor terminal. */
export function emptyCandidateResult(
  input: CandidateTerminalContext & {
    budgetStopped: boolean;
    budgetDenial: BudgetDenial | null;
  },
): OrchestratorResult {
  const { ledger, budgetStopped, budgetDenial, mode, store, paths, log, runId, taskId } = input;
  const budgetReason = ledger.terminal();
  // QA-050: when the zero-candidate cause is a budget refusal, the shared
  // classifier owns the typed code, the refused route/slot, and actionable
  // budget remediation (previously an empty nextActions array).
  const agentBudgetMapping =
    budgetStopped || budgetReason
      ? classifyBudgetFailure({ denial: budgetDenial, terminal: budgetReason })
      : null;
  const facts = makeOutcomeFacts("failed", {
    reason: agentBudgetMapping?.reason ?? (budgetStopped ? "budget_exhausted" : "harness_failed"),
    noChanges: true,
  });
  const why = agentBudgetMapping?.safeMessage ?? "no candidates produced";
  store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
    winner: null,
    facts,
    why_winner: why,
    evidence_facts: ["no candidates were produced"],
    apply_recommendation: "continue",
    budget_summary: decisionBudgetSummary(ledger),
  });
  store.writeText(
    join(paths.finalDir, "summary.md"),
    `# Run ${runId} (${mode})\n\n- Lifecycle: ${facts.lifecycle}${facts.reason ? ` (${facts.reason})` : ""}\n- Phase: ${agentBudgetMapping ? "budget" : "executor"}\n\n${why}\n`,
  );
  if (agentBudgetMapping) {
    writeFailure(store, paths, budgetFailureRecord(agentBudgetMapping, { runDir: paths.root }));
  } else {
    writeFailure(store, paths, {
      phase: "executor",
      category: "internal",
      safeMessage: why,
      runDir: paths.root,
      nextActions: ["Open diagnostics", "Retry the run"],
    });
  }
  log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  log.emit("run.failed", {
    lifecycle: facts.lifecycle,
    facts,
    reason: facts.reason,
    phase: agentBudgetMapping ? "budget" : "executor",
    ...(agentBudgetMapping?.harnessId ? { harness_id: agentBudgetMapping.harnessId } : {}),
    error: why,
    failure_ref: "final/failure.yaml",
  });
  return {
    runId,
    taskId,
    mode,
    lifecycle: facts.lifecycle,
    facts,
    winner: null,
    runDir: paths.root,
    summary: why,
    candidates: [],
    spendUsd: ledger.spend(),
  };
}

/** The same no-working-candidate terminal, including retained partial file evidence. */
export async function failedCandidatesResult(
  input: CandidateTerminalContext & {
    runs: CandidateRun[];
    budgetDenial?: BudgetDenial | null;
    writeTelemetry(): void;
  },
): Promise<OrchestratorResult> {
  const { store, paths, log, runId, taskId, mode, ledger, runs, writeTelemetry } = input;
  const first = runs[0] as CandidateRun;
  const budget = input.budgetDenial
    ? classifyBudgetFailure({ denial: input.budgetDenial, terminal: ledger.terminal() })
    : null;
  const phase =
    budget?.phase ??
    (first.captureRefusal
      ? (first.captureRefusal.phase ?? "workspace")
      : (first.infraPhase ?? "harness"));
  const partition = partitionCandidates(runs);
  const facts = budget ? { ...partition.facts, reason: budget.reason } : partition.facts;
  const rootCause = budget?.safeMessage ?? partition.why;
  const captured = runs.find((run) => run.files);
  if (captured?.files)
    await publishDirectoryCandidate({
      files: captured.files,
      store,
      paths,
      taskId,
      attemptId: captured.attemptId,
      harnessId: captured.harnessId,
      facts,
      log,
    });
  store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
    winner: null,
    facts,
    why_winner: rootCause,
    evidence_facts: runs.map((r) => `${r.attemptId} produced no work: ${r.errors[0] ?? "unknown"}`),
    apply_recommendation: "continue",
    budget_summary: decisionBudgetSummary(ledger),
  });
  writeTelemetry();
  store.writeText(
    join(paths.finalDir, "summary.md"),
    `# Run ${runId} (${mode})\n\n- Lifecycle: ${facts.lifecycle}\n- Phase: ${phase}\n\n${rootCause}\n`,
  );
  const existingEventRefs = runs
    .map((r) => `attempts/${r.attemptId}/events.jsonl`)
    .filter((rel) => existsSync(join(paths.root, rel)));
  if (!existingEventRefs.length && existsSync(paths.eventsPath))
    existingEventRefs.push("events.jsonl");
  // #31: auth guidance only on a classified auth failure; every other
  // harness cause (timeout, rate limit, crash, config) gets remediation that
  // fits it, instead of a doomed "Check harness authentication".
  const harnessCategory = dominantHarnessFailureCategory(first.telemetry.transientFailures);
  // A run speaks with a candidate's TYPED refusal only when EVERY candidate
  // died of the same one (candidateEvidence owns that rule); mixed causes
  // keep the honest harness terminal.
  const unanimous = unanimousDeclaredFailure(runs);
  writeFailure(store, paths, {
    phase,
    category: unanimous?.category ?? (phase === "workspace" ? "project" : "harness_error"),
    code: unanimous?.code ?? null,
    harnessId: first.harnessId,
    attemptId: first.attemptId,
    safeMessage: rootCause,
    rawDetailRef: `attempts/${first.attemptId}/attempt.yaml`,
    eventRefs: existingEventRefs,
    runDir: paths.root,
    resetsAt: unanimous?.resetsAt ?? null,
    requestRefusal: unanimous?.requestRefusal,
    // The first candidate speaks (like harnessId/attemptId); a budget terminal speaks for itself.
    vendorFailure: budget ? null : attemptVendorFailure([first], first.attemptId),
    nextActions: first.captureRefusal
      ? secretDiff.captureRefusalNextActions(first.captureRefusal)
      : phase === "workspace"
        ? ["Check the project folder", "Open diagnostics", "Retry the run"]
        : harnessFailureNextActions(harnessCategory),
    ...(budget
      ? budgetFailureRecord(budget, { eventRefs: existingEventRefs, runDir: paths.root })
      : {}),
  });
  log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  log.emit("run.failed", {
    lifecycle: facts.lifecycle,
    facts,
    reason: facts.reason,
    phase,
    error: rootCause,
    failure_ref: "final/failure.yaml",
  });
  return {
    runId,
    taskId,
    mode,
    lifecycle: facts.lifecycle,
    facts,
    winner: null,
    runDir: paths.root,
    summary: rootCause,
    candidates: runs.map((r) => ({
      attemptId: r.attemptId,
      harnessId: r.harnessId,
      status: "red",
    })),
    spendUsd: ledger.spend(),
  };
}
