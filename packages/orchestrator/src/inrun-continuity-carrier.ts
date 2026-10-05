/**
 * The in-run continuation's I/O-bearing seams, split out of the per-attempt
 * controller (`inrun-continuity.ts`) so the controller stays a readable state
 * machine: composing the spec of a continued try (carrier → prompt/resume id),
 * the moved-session thread disclosure (INV-137), the uncertain-input
 * reference, the per-try receipt and the terminal `resumable` block. Free
 * functions over explicit inputs; the controller owns the mutable state.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptedTryOutput } from "@claudexor/core";
import {
  HarnessRunSpec as HarnessRunSpecSchema,
  RunContinuityReceipt as RunContinuityReceiptSchema,
  type ContinuityIdentityCheck,
  type HarnessRunSpec,
  type ResumableCause,
  type RunContinuityReceipt,
  type RunResumable,
  type SessionCapsule,
} from "@claudexor/schema";
import { decideCarrier, prepareCarrier, type CarrierFacts } from "./carrier-planner.js";
import { diffStatFromPatch, steeringFromRunLog } from "./continuation-evidence-io.js";
import { continuationNotice, packetContinuationPrompt } from "./continuity-notice.js";
import type { AfterTryVerdict, InRunContinuityDeps, TryFacts } from "./inrun-continuity.js";
import { routeListsModel } from "./modelGovernance.js";
import {
  registryProfile,
  relocateSessionCapsule,
  storeEnvFor,
  writeSessionCapsule,
} from "./session-capsule.js";

/** What the controller remembers about the try it prepared as a continuation. */
export interface ContinuedTry {
  carrier: RunContinuityReceipt["carrier"];
  cause: ResumableCause;
  fromProfileId: string | null;
  toProfileId: string | null;
  memory: RunContinuityReceipt["memory"];
  inputDelivery: RunContinuityReceipt["inputDelivery"];
}

/** The typed limit that ended a try (A11 evidence quality). */
export interface LimitEvidenceState {
  resetsAt: string | null;
  retryDelayMs: number | null;
  constraintId: string | null;
}

export interface ContinuedTryContext {
  deps: InRunContinuityDeps;
  capsule: SessionCapsule | null;
  acted: boolean;
  nativeRejected: boolean;
  /** Index of the try that just settled; the successor is `tryIndex + 1`. */
  tryIndex: number;
  uncertainInput: string | null;
}

export interface ComposedContinuedTry {
  verdict: AfterTryVerdict;
  /** Null for a fresh replay (today's rule). */
  continued: ContinuedTry | null;
  /** The capsule after a native location/move (the new holder), or null when unchanged. */
  capsule: SessionCapsule | null;
  /** The session was moved into another account's store (disclose on the thread). */
  moved: { from: string | null; to: string | null } | null;
}

function profileRef(deps: InRunContinuityDeps, spec: HarnessRunSpec, profileId: string | null) {
  const row = registryProfile(deps.registry, profileId);
  return {
    profileId,
    env: storeEnvFor(spec.env, row),
    storeLocator: row?.isolation_locator ?? null,
  };
}

/** Plan and prepare the carrier for the next try, then compose its spec. */
export async function composeContinuedTry(
  ctx: ContinuedTryContext,
  facts: TryFacts,
  base: HarnessRunSpec,
  cause: ResumableCause,
  delayMs: number,
): Promise<ComposedContinuedTry> {
  const { deps } = ctx;
  const from = facts.runSpec.credential_profile?.profile_id ?? null;
  const to = base.credential_profile?.profile_id ?? null;
  const effectiveModel = facts.telemetry.observedModel ?? base.model_hint ?? null;
  const carrierFacts: CarrierFacts = {
    capsule: ctx.capsule,
    acted: ctx.acted,
    cause,
    sourceProfile: profileRef(deps, facts.runSpec, from),
    targetProfile: profileRef(deps, base, to),
    effectiveModel,
    preference: "auto",
    adapter: deps.adapter,
    nativeRejected: ctx.nativeRejected,
  };
  const prepared = await prepareCarrier(decideCarrier(carrierFacts), {
    facts: carrierFacts,
    evidence: {
      runDir: deps.runDir,
      attemptId: deps.attemptId,
      workOrder: deps.workOrder,
      steering: [],
    },
    targetCwd: base.cwd,
    retainedOutput: acceptedTryOutput(facts.answer, facts.harnessErrored) || facts.answer.text(),
    diffStat: facts.currentDiff ? diffStatFromPatch(facts.currentDiff) : null,
  });
  if (prepared.carrier === "fresh") {
    return {
      verdict: { kind: "continue", spec: base, delayMs },
      continued: null,
      capsule: null,
      moved: null,
    };
  }
  const notice = continuationNotice({
    cause,
    uncertainInput: ctx.uncertainInput,
    callerText: null,
  });
  // A null model hint must not re-resolve to another default on a new session
  // (§7.1): the packet pins the attested model, but only an id the route itself
  // lists — an observed display label is never sent as a model id.
  const attested = facts.telemetry.observedModel;
  const pinned =
    base.model_hint == null && prepared.carrier === "packet" && attested
      ? !!deps.route && (await routeListsModel(deps.route, base, attested))
      : false;
  const modelHint = base.model_hint ?? (pinned ? attested : null);
  const continued: ContinuedTry = {
    carrier: prepared.carrier,
    cause,
    fromProfileId: from,
    toProfileId: to,
    memory: prepared.carrier === "packet" ? "partial" : "full",
    inputDelivery: ctx.uncertainInput === null ? "confirmed" : "uncertain",
  };
  if (prepared.carrier === "packet") {
    const dir = join(deps.attemptDir, "continuation");
    mkdirSync(dir, { recursive: true });
    const evidencePath = join(dir, `evidence-index-try${ctx.tryIndex + 1}.md`);
    writeFileSync(evidencePath, prepared.packet.markdown);
    const spec = HarnessRunSpecSchema.parse({
      ...base,
      model_hint: modelHint,
      resume_session_id: null,
      prompt: packetContinuationPrompt({
        originalPrompt: deps.firstPrompt,
        notice,
        evidencePath,
        evidenceMarkdown: prepared.packet.markdown,
      }),
    });
    return { verdict: { kind: "continue", spec, delayMs }, continued, capsule: null, moved: null };
  }
  writeSessionCapsule(deps.attemptDir, prepared.capsule);
  const spec = HarnessRunSpecSchema.parse({
    ...base,
    model_hint: modelHint,
    resume_session_id: prepared.resumeRef.nativeSessionId,
    prompt: notice,
  });
  return {
    verdict: { kind: "continue", spec, delayMs },
    continued,
    capsule: prepared.capsule,
    moved: prepared.carrier === "native_moved" ? { from, to } : null,
  };
}

/** The predecessor's input that may not be in the vendor history: the last
 * try's prompt when it died before `started`, plus admitted-but-unconfirmed
 * steering messages (`message.accepted` with no `message.delivered`). */
export function uncertainInputFor(
  runDir: string,
  previousTryUnstarted: string | null,
): string | null {
  const parts: string[] = [];
  if (previousTryUnstarted) parts.push(previousTryUnstarted.slice(0, 2048));
  for (const message of steeringFromRunLog(runDir))
    if (message.delivery === "uncertain") parts.push(message.text.slice(0, 2048));
  return parts.length ? parts.join("\n\n") : null;
}

/** INV-137: a moved session on a thread lane is a disclosed lane switch that
 * resumes natively; its row is published only when the file survives dispose. */
export function discloseMovedSession(
  deps: InRunContinuityDeps,
  capsule: SessionCapsule,
  from: string | null,
  to: string | null,
  observedModel: string | null,
): void {
  const thread = deps.thread;
  if (!thread) return;
  const survives =
    deps.inPlace ||
    !capsule.file ||
    !deps.isolatedHomeDir ||
    !capsule.file.startsWith(deps.isolatedHomeDir);
  if (survives)
    thread.onSessionObserved?.(deps.adapter.id, capsule.nativeSessionId, observedModel, to);
  deps.emit("session.continuity", {
    thread_id: thread.threadId,
    harness_id: deps.adapter.id,
    kind: "native_resume",
    packet_turns: 0,
    summarized: false,
    lane_switched_from: { harness: deps.adapter.id, profileId: from },
    moved: true,
  });
  if (thread.turnId)
    thread.onContinuityResolved?.(thread.turnId, {
      kind: "native_resume",
      packetTurns: 0,
      summarized: false,
      laneSwitchedFrom: { harness: deps.adapter.id, profileId: from },
    });
}

/** The receipt of a continued try (per-try model attestation, never borrowed). */
export function continuityReceipt(input: {
  deps: InRunContinuityDeps;
  continued: ContinuedTry;
  tryIndex: number;
  requestedModel: string | null;
  observedModel: string | null;
  nativeRejected: boolean;
  identity: ContinuityIdentityCheck;
  reingestedTokens: number | null;
}): RunContinuityReceipt {
  const { deps, continued, requestedModel: requested, observedModel: observed } = input;
  return RunContinuityReceiptSchema.parse({
    tryIndex: input.tryIndex,
    attemptId: deps.attemptId,
    carrier: continued.carrier,
    cause: continued.cause,
    from: { runId: deps.runId, attemptId: deps.attemptId, profileId: continued.fromProfileId },
    to: { profileId: continued.toProfileId },
    workspace: "same_root",
    memory: continued.memory === "full" && input.nativeRejected ? "unknown" : continued.memory,
    instructions: "as_sent",
    reingestedTokens: input.reingestedTokens,
    observedModel: observed,
    modelMismatch: requested !== null && observed !== null ? requested !== observed : null,
    identityCheck: continued.carrier === "packet" ? "not_applicable" : input.identity,
    inputDelivery: continued.inputDelivery,
  });
}

/** The terminal `resumable` block of an attempt whose work is unfinished. */
export function resumableBlock(input: {
  deps: InRunContinuityDeps;
  cause: ResumableCause;
  capsule: SessionCapsule | null;
  nativeRejected: boolean;
  acted: boolean;
  limit: LimitEvidenceState | null;
  terminalCode: string | null;
}): RunResumable {
  const { deps, limit } = input;
  const session = input.capsule && !input.nativeRejected ? input.capsule : null;
  const carriers: RunResumable["carriers"] = [];
  if (session) {
    carriers.push("native");
    if (deps.adapter.continuity) carriers.push("native_moved");
  }
  if (input.acted) carriers.push("packet");
  return {
    cause: input.cause,
    resetsAt: limit?.resetsAt ?? null,
    limitWindow: limit?.constraintId ?? null,
    limitEvidence: limit ? (limit.resetsAt || limit.constraintId ? "window" : "unspecified") : null,
    carriers,
    limitCode: input.terminalCode ?? (limit ? "vendor_limit_rejected" : null),
    session: session
      ? {
          harness: session.harness,
          nativeSessionId: session.nativeSessionId,
          holderProfileId: session.holderProfileId,
        }
      : null,
    workspace: deps.inPlace ? { kind: "in_place", root: deps.cwd } : { kind: "none", root: null },
  };
}

/** Re-locate the capsule's holder through the adapter after a try settles; a hit is persisted. */
export async function relocateCapsule(
  deps: InRunContinuityDeps,
  capsule: SessionCapsule,
  runSpec: HarnessRunSpec,
): Promise<SessionCapsule> {
  const holder = registryProfile(deps.registry, capsule.holderProfileId);
  const located = await relocateSessionCapsule(
    capsule,
    deps.adapter.continuity,
    storeEnvFor(runSpec.env, holder),
  );
  if (located.located !== true) return capsule;
  writeSessionCapsule(deps.attemptDir, located.capsule);
  return located.capsule;
}
