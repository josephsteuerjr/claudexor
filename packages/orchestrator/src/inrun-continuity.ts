/**
 * In-run continuation (the owner's "auto-rotation inside the work"): ONE
 * per-attempt controller both the candidate loop and the read-only twin call,
 * so the two lanes never re-derive the ladder (A8).
 *
 * Per try it OBSERVES the stream (the native session id → the capsule, the
 * per-try attested model, the typed limit that ended the try, the identity of
 * a resumed session, the adapter's typed rejection of carried state) and AFTER
 * the try decides what the attempt does next:
 *
 *   - the attempt did NOT act → today's rules, byte for byte (typed-limit /
 *     structural rotation onto a fresh session, same-profile transient retry);
 *   - it acted and a typed vendor limit ended the try → hop to the next
 *     eligible account with the session moved (`native_moved`) or, when the
 *     session cannot be moved, re-briefed by the evidence index (`packet`,
 *     owner 1B) — never a fresh replay of the original prompt;
 *   - it acted and the process died (transport) → the same account resumes
 *     its own session (`native`), or `packet` once a typed fact rejected the
 *     native carrier, bounded by `transient_retry.max_retries` per account;
 *   - pinned / `fail` / `ask` / pool spent → a typed terminal that still
 *     carries the `resumable` facts (cause, reset, carriers).
 *
 * "Acted" is sticky for the whole attempt (any accepted answer text, any agent
 * progress marker, any file change or workspace diff in ANY try): a silent
 * resumed try never re-opens the `fresh` rung. Hops are bounded by
 * `triedProfiles`; same-account continuations by `max_retries` (A2).
 */
import {
  CONTINUITY_IDENTITY_MISMATCH_CODE,
  acceptedTryOutput,
  type AnswerAssembly,
  type HarnessAdapter,
} from "@claudexor/core";
import {
  HarnessRunSpec as HarnessRunSpecSchema,
  type ContinuityIdentityCheck,
  type CredentialProfile,
  type HarnessEvent,
  type HarnessRunSpec,
  type QuotaSnapshot,
  type ResumableCause,
  type RunContinuityReceipt,
  type RunEventType,
  type RunResumable,
  type SessionCapsule,
  type WorkState,
} from "@claudexor/schema";
import type { AttemptOutputMarkers } from "./attemptOutputMarkers.js";
import type { AttemptTelemetry, TransientFailureObservation } from "./attemptTelemetry.js";
import {
  composeContinuedTry,
  continuityReceipt,
  discloseMovedSession,
  relocateCapsule,
  resumableBlock,
  uncertainInputFor,
  type ContinuedTry,
  type LimitEvidenceState,
} from "./inrun-continuity-carrier.js";
import {
  effectiveLimitAction,
  limitSubjectRoute,
  rotateSpecOnTypedLimit,
  type EmitFn,
  type ProfilePolicy,
} from "./credential-profile-rotation.js";
import { emitTransientRetryPlan } from "./laneStreamEvents.js";
import { rotatedSpecInLaneHome } from "./orchestrator-credentials.js";
import type { PreProgressRefusalSubject } from "./pre-progress-refusal.js";
import { transientRetryDelayMs, type TransientRetryPolicy } from "./runSupport.js";
import { readSessionCapsule, writeSessionCapsule } from "./session-capsule.js";

type ContinuityEmit = (type: RunEventType, payload: Record<string, unknown>) => void;

export interface InRunContinuityDeps {
  adapter: HarnessAdapter;
  runId: string;
  attemptId: string;
  /** The run dir (`paths.root`) — the evidence index reads `events.jsonl` there. */
  runDir: string;
  attemptDir: string;
  /** Execution root the child runs in. */
  cwd: string;
  inPlace: boolean;
  /** The isolated envelope's scoped HOME, or null in place: a located session
   * file under it does not survive dispose and is never published to a thread. */
  isolatedHomeDir: string | null;
  /** The caller's original prompt (the work order), for the evidence index. */
  workOrder: string;
  /** The first try's full prompt (engine constraints included) — the packet carrier resends it. */
  firstPrompt: string;
  registry: readonly CredentialProfile[];
  policy: ProfilePolicy;
  snapshots: readonly QuotaSnapshot[];
  retryPolicy: TransientRetryPolicy;
  pinned: boolean;
  defaultRouteWasVendorNative: boolean;
  requestedProfileId: string | null;
  /** False when the lane has no RunInput: rotation never fired there, and still does not. */
  rotationEnabled: boolean;
  laneEnvFor: (profileId: string | null) => Record<string, string> | null;
  probeReadyProfiles: (spec: HarnessRunSpec, tried: Set<string>) => Promise<ReadonlySet<string>>;
  rotationObservations: (
    spec: HarnessRunSpec,
    transients: readonly TransientFailureObservation[],
    refusal: PreProgressRefusalSubject | null,
  ) => Pick<
    Parameters<typeof rotateSpecOnTypedLimit>[0],
    "probeCurrentSubject" | "liveUnusable" | "notePreProgressRefusal"
  >;
  emit: ContinuityEmit;
  newSessionId: () => string;
  /** Thread facts for the moved-session disclosure (INV-137); null outside a thread. */
  thread: {
    threadId: string;
    turnId: string | null;
    onSessionObserved?: (
      harnessId: string,
      nativeSessionId: string,
      observedModel?: string | null,
      profileId?: string | null,
    ) => void;
    onContinuityResolved?: (
      turnId: string,
      disclosure: {
        kind: "native_resume" | "packet" | "fresh";
        packetTurns: number;
        summarized: boolean;
        laneSwitchedFrom: { harness: string; profileId: string | null } | null;
      },
    ) => void;
  } | null;
}

/** What the loop knows when a try has settled. */
export interface TryFacts {
  runSpec: HarnessRunSpec;
  nativeTry: number;
  harnessErrored: boolean;
  aborted: boolean;
  requestRefused: boolean;
  newTransients: readonly TransientFailureObservation[];
  sawTypedLimit: boolean;
  sawRetryable: boolean;
  answer: AnswerAssembly;
  /** Today's transient-gate fact (raw: workspace unchanged and no answer text). */
  rawDeliverableEmpty: boolean;
  /** Candidate lane: the workspace diff is non-empty (the read-only lane omits it). */
  workspaceDiffNonEmpty?: boolean;
  /** The current workspace diff when the lane has one (evidence index file list). */
  currentDiff?: string;
  markers: AttemptOutputMarkers;
  lastLimit: { retryDelayMs: number | null; resetsAt: string | null } | null;
  refusal: PreProgressRefusalSubject | null;
  telemetry: AttemptTelemetry;
}

export type AfterTryVerdict =
  | { kind: "continue"; spec: HarnessRunSpec; delayMs: number }
  /** A typed terminal (pinned limit, pool spent): the loop records the error and stops. */
  | { kind: "terminal"; error: Error }
  | { kind: "break" };

const TYPED_REFUSALS = new Set(["auth_failed", "capability_refused", "config_error"]);

export class InRunContinuity {
  private capsule: SessionCapsule | null;
  private acted = false;
  private nativeRejected = false;
  private readonly triedProfiles = new Set<string>();
  private sameAccountTries = 0;
  private lastCause: ResumableCause | null = null;
  private limit: LimitEvidenceState | null = null;
  private terminalCode: string | null = null;
  // Per-try state.
  private tryIndex = 0;
  private tryAbort: AbortController | null = null;
  private tryStarted = false;
  private tryPrompt = "";
  private expectedSessionId: string | null = null;
  private tryModel: string | null = null;
  private tryRequestedModel: string | null = null;
  private tryIdentity: ContinuityIdentityCheck = "not_applicable";
  private tryFirstInputTokens: number | null = null;
  private continued: ContinuedTry | null = null;
  /** Carrier of the try that just settled (null = the first try or a fresh replay). */
  private settledCarrier: RunContinuityReceipt["carrier"] | null = null;
  private previousTryUnstarted: string | null = null;

  constructor(private readonly deps: InRunContinuityDeps) {
    this.capsule = readSessionCapsule(deps.attemptDir);
  }

  /** The loop calls this before each try spawns; `abort` is THIS try's controller. */
  beginTry(runSpec: HarnessRunSpec, nativeTry: number, abort: AbortController): void {
    this.tryIndex = nativeTry;
    this.tryAbort = abort;
    this.tryStarted = false;
    this.tryPrompt = runSpec.prompt;
    this.expectedSessionId = runSpec.resume_session_id ?? null;
    this.tryModel = null;
    this.tryRequestedModel = runSpec.model_hint ?? null;
    this.tryIdentity = "not_applicable";
    this.tryFirstInputTokens = null;
  }

  /**
   * Observe one stream event. Returns the typed error that STOPS the try now
   * (the resumed session is not the one requested — a mismatch caught before
   * effects when no agent progress was seen yet; the child is aborted), else
   * null.
   */
  observe(ev: HarnessEvent, runSpec: HarnessRunSpec, markers: AttemptOutputMarkers): string | null {
    if (ev.observed_model && this.tryModel === null) this.tryModel = ev.observed_model;
    if (ev.rate_limit) {
      this.limit = {
        resetsAt: ev.rate_limit.resets_at ?? null,
        retryDelayMs: ev.rate_limit.retry_delay_ms ?? null,
        constraintId: ev.rate_limit.constraint_id ?? null,
      };
    }
    if (ev.type === "usage" && this.expectedSessionId && this.tryFirstInputTokens === null) {
      const input = ev.usage?.input_token_usage?.total_tokens ?? ev.usage?.input_tokens ?? null;
      if (input !== null) this.tryFirstInputTokens = input;
    }
    if (
      ev.type === "error" &&
      this.expectedSessionId &&
      ev.payload?.["code"] === CONTINUITY_IDENTITY_MISMATCH_CODE
    ) {
      // The adapter compared the recovered handle at its earliest handshake,
      // before any action (codex thread/resume precedes turn/start).
      this.tryIdentity = "mismatch_before_effects";
      this.nativeRejected = true;
      return null;
    }
    if (this.expectedSessionId && this.deps.adapter.continuity?.rejectsCarriedState?.(ev)) {
      this.nativeRejected = true;
    }
    if (ev.type !== "started") return null;
    this.tryStarted = true;
    const nid = ev.payload?.["native_session_id"];
    if (typeof nid !== "string" || nid.length === 0) return null;
    if (this.expectedSessionId && nid !== this.expectedSessionId) {
      this.tryIdentity = markers.sawAgentProgress
        ? "mismatch_after_possible_effects"
        : "mismatch_before_effects";
      this.nativeRejected = true;
      this.tryAbort?.abort();
      void this.deps.adapter.cancel?.(runSpec.session_id)?.catch(() => {});
      return `resumed native session ${nid} is not the requested ${this.expectedSessionId}; the try was stopped${markers.sawAgentProgress ? " (effects may have occurred)" : " before any effect"}`;
    }
    if (this.expectedSessionId) this.tryIdentity = "matched_before_effects";
    // A new native session (or the resumed one) is the attempt's capsule now.
    this.nativeRejected = false;
    this.capsule = {
      harness: this.deps.adapter.id,
      nativeSessionId: nid,
      holderProfileId: ev.credential_profile_id ?? runSpec.credential_profile?.profile_id ?? null,
      file: this.capsule?.nativeSessionId === nid ? this.capsule.file : null,
      mtimeMs: this.capsule?.nativeSessionId === nid ? this.capsule.mtimeMs : null,
      sidecars: this.capsule?.nativeSessionId === nid ? this.capsule.sidecars : [],
      cwd: runSpec.cwd,
      requestedModel: runSpec.model_hint ?? null,
    };
    writeSessionCapsule(this.deps.attemptDir, this.capsule);
    return null;
  }

  /** Decide what the attempt does after a settled try. */
  async afterTry(facts: TryFacts): Promise<AfterTryVerdict> {
    const accepted = acceptedTryOutput(facts.answer, facts.harnessErrored);
    this.acted ||=
      accepted.length > 0 ||
      facts.markers.sawAgentProgress ||
      facts.markers.fileChanges > 0 ||
      facts.workspaceDiffNonEmpty === true;
    await this.relocate(facts.runSpec);
    this.settledCarrier = this.continued?.carrier ?? null;
    this.emitReceipt(facts.runSpec);
    this.previousTryUnstarted = this.tryStarted ? null : this.tryPrompt;
    if (!facts.harnessErrored || facts.aborted) return { kind: "break" };
    if (facts.requestRefused) return this.breakWith("other");
    if (facts.telemetry.contextExhausted) return this.breakWith("context_exhausted");
    if (!this.acted) return this.legacy(facts);
    const typedRefusal = facts.newTransients.some((t) => TYPED_REFUSALS.has(t.category));
    if (typedRefusal) return this.breakWith("other");
    // A11: a bare backoff frame (a delay, no reset, no constraint) is transport —
    // the same session is simply resumed — when a session exists to resume;
    // without one the typed limit still hops (nothing to resume on this account).
    const backoffOnly =
      this.limit !== null &&
      !this.limit.resetsAt &&
      !this.limit.constraintId &&
      this.limit.retryDelayMs !== null;
    if (facts.sawTypedLimit && (!backoffOnly || this.capsule === null)) {
      return this.afterLimit(facts);
    }
    return this.afterTransport(facts);
  }

  /** Receipts, capsule relocation and the terminal `resumable` block once the attempt ends. */
  async finish(input: {
    runSpec: HarnessRunSpec;
    errored: boolean;
    aborted: boolean;
    cancelReason: string | null;
    workState: WorkState | null | undefined;
  }): Promise<RunResumable | null> {
    await this.relocate(input.runSpec);
    const vetoed =
      input.workState?.state === "needs_input" || input.workState?.state === "incomplete";
    if (!input.errored && !input.aborted && !vetoed) return null;
    const cause: ResumableCause = vetoed
      ? input.workState?.state === "needs_input"
        ? "input_required"
        : "other"
      : input.aborted
        ? input.cancelReason === "wall_clock_exceeded"
          ? "wall_clock"
          : "cancelled"
        : (this.lastCause ?? "other");
    return this.resumable(cause);
  }

  resumable(cause: ResumableCause): RunResumable {
    return resumableBlock({
      deps: this.deps,
      cause,
      capsule: this.capsule,
      nativeRejected: this.nativeRejected,
      acted: this.acted,
      limit: this.limit,
      terminalCode: this.terminalCode,
    });
  }

  private breakWith(cause: ResumableCause): AfterTryVerdict {
    this.lastCause = cause;
    return { kind: "break" };
  }

  /** Today's rules for an attempt that did not act: typed-limit / structural
   * rotation onto a fresh session, then the same-profile transient gate. */
  private async legacy(facts: TryFacts): Promise<AfterTryVerdict> {
    const rotated = await this.rotate(facts, false);
    if (rotated && "poolExhausted" in rotated) {
      this.lastCause = "pool_exhausted";
      this.terminalCode = codeOf(rotated.poolExhausted);
      return { kind: "terminal", error: rotated.poolExhausted };
    }
    if (rotated) {
      this.hopped(rotated);
      return { kind: "continue", spec: this.inLaneHome(facts.runSpec, rotated), delayMs: 0 };
    }
    this.lastCause = facts.sawTypedLimit ? "vendor_limit" : "transport";
    if (
      !facts.sawRetryable ||
      !facts.rawDeliverableEmpty ||
      facts.nativeTry >= this.deps.retryPolicy.maxRetries
    )
      return { kind: "break" };
    const delayMs = emitTransientRetryPlan(
      (t, p) => this.deps.emit(t, p),
      this.deps.adapter.id,
      this.deps.attemptId,
      facts.telemetry,
      facts.nativeTry,
      this.deps.retryPolicy,
    );
    const spec = HarnessRunSpecSchema.parse({
      ...facts.runSpec,
      session_id: this.deps.newSessionId(),
      resume_session_id: null,
      extra: { ...facts.runSpec.extra },
    });
    return { kind: "continue", spec, delayMs };
  }

  /** A typed vendor limit ended a try that acted: hop with the session (2A) or a packet (1B). */
  private async afterLimit(facts: TryFacts): Promise<AfterTryVerdict> {
    const route = limitSubjectRoute(
      facts.runSpec.credential_profile ?? null,
      this.deps.defaultRouteWasVendorNative ? "local_session" : null,
    );
    if (this.deps.pinned) {
      this.lastCause = "pinned_limit";
      this.terminalCode = "subscription_window_exhausted";
      return {
        kind: "terminal",
        error: Object.assign(
          new Error(
            `credential profile "${facts.runSpec.credential_profile?.profile_id ?? "default"}" (${this.deps.adapter.id}) hit a typed vendor limit after progress and a pinned account never rotates${this.limit?.resetsAt ? `; resets ${this.limit.resetsAt}` : ""}`,
          ),
          {
            code: "subscription_window_exhausted",
            category: "harness_unavailable",
            resetsAt: this.limit?.resetsAt ?? null,
          },
        ),
      };
    }
    if (effectiveLimitAction(this.deps.policy, route) !== "rotate")
      return this.breakWith("vendor_limit");
    const rotated = await this.rotate(facts, true);
    if (rotated && "poolExhausted" in rotated) {
      this.lastCause = "pool_exhausted";
      this.terminalCode = codeOf(rotated.poolExhausted);
      return { kind: "terminal", error: rotated.poolExhausted };
    }
    if (!rotated) return this.breakWith("vendor_limit");
    this.hopped(rotated);
    this.lastCause = "vendor_limit";
    return this.prepareContinuedTry(
      facts,
      this.inLaneHome(facts.runSpec, rotated),
      "vendor_limit",
      0,
    );
  }

  /** The process died after progress: the same account resumes its session
   * (bounded), or re-briefs once a typed fact rejected that session. With no
   * session recorded at all there is nothing to resume: the run ends
   * continuable (`resumable`, carrier packet) for the caller. */
  private async afterTransport(facts: TryFacts): Promise<AfterTryVerdict> {
    this.lastCause = "transport";
    if (this.capsule === null) {
      // A packet try that died before doing anything replayed no effect: the
      // structural branch hops it to the next account with the same packet
      // (today's pre-progress failover, now on the packet carrier). Anything
      // else with no session to resume ends continuable for the caller.
      const packetDiedUnused =
        this.settledCarrier === "packet" &&
        !facts.sawRetryable &&
        !facts.markers.sawAgentProgress &&
        facts.markers.fileChanges === 0;
      if (!packetDiedUnused) return { kind: "break" };
      const rotated = await this.rotate(facts, true);
      if (rotated && "poolExhausted" in rotated) {
        this.lastCause = "pool_exhausted";
        this.terminalCode = codeOf(rotated.poolExhausted);
        return { kind: "terminal", error: rotated.poolExhausted };
      }
      if (!rotated) return { kind: "break" };
      this.hopped(rotated);
      return this.prepareContinuedTry(
        facts,
        this.inLaneHome(facts.runSpec, rotated),
        "transport",
        0,
      );
    }
    if (this.sameAccountTries >= this.deps.retryPolicy.maxRetries) return { kind: "break" };
    const retryIndex = this.sameAccountTries;
    this.sameAccountTries += 1;
    const spec = HarnessRunSpecSchema.parse({
      ...facts.runSpec,
      session_id: this.deps.newSessionId(),
      extra: { ...facts.runSpec.extra },
    });
    const delayMs = transientRetryDelayMs(
      facts.newTransients.at(-1)?.retryDelayMs ?? this.limit?.retryDelayMs ?? null,
      this.deps.retryPolicy,
      retryIndex,
    );
    return this.prepareContinuedTry(facts, spec, "transport", delayMs);
  }

  private async rotate(
    facts: TryFacts,
    forceEligible: boolean,
  ): Promise<Awaited<ReturnType<typeof rotateSpecOnTypedLimit>>> {
    if (!this.deps.rotationEnabled) return null;
    const { runSpec } = facts;
    const accepted = acceptedTryOutput(facts.answer, facts.harnessErrored);
    return rotateSpecOnTypedLimit({
      spec: runSpec,
      harnessId: this.deps.adapter.id,
      attemptId: this.deps.attemptId,
      policy: this.deps.policy,
      registry: this.deps.registry,
      snapshots: this.deps.snapshots,
      probeReadyProfiles: () => this.deps.probeReadyProfiles(runSpec, this.triedProfiles),
      ...this.deps.rotationObservations(runSpec, facts.newTransients, facts.refusal),
      triedProfiles: this.triedProfiles,
      // After progress the predicate's no-deliverable/no-mutation fence scopes
      // only the `fresh` carrier: the planner picks the carrier, rotation only
      // picks the next account.
      markers: forceEligible
        ? {
            sawAgentProgress: false,
            fileChanges: 0,
            sawSessionStart: facts.markers.sawSessionStart,
          }
        : facts.markers,
      requestRefused: facts.requestRefused,
      sawTypedLimit: facts.sawTypedLimit,
      sawRetryable: facts.sawRetryable,
      attemptErrored: facts.harnessErrored,
      deliverableEmpty: forceEligible
        ? true
        : facts.workspaceDiffNonEmpty !== true && accepted.length === 0,
      workspaceDiffNonEmpty: forceEligible ? false : facts.workspaceDiffNonEmpty,
      lastLimit: facts.lastLimit,
      emit: this.deps.emit as EmitFn,
      newSessionId: this.deps.newSessionId,
      defaultRouteWasVendorNative: this.deps.defaultRouteWasVendorNative,
      pinned: this.deps.pinned,
    });
  }

  private hopped(rotated: HarnessRunSpec): void {
    if (rotated.credential_profile) this.triedProfiles.add(rotated.credential_profile.profile_id);
    this.sameAccountTries = 0;
  }

  private inLaneHome(previous: HarnessRunSpec, rotated: HarnessRunSpec): HarnessRunSpec {
    return rotatedSpecInLaneHome(
      previous,
      rotated,
      this.deps.laneEnvFor,
      this.deps.requestedProfileId,
    );
  }

  /** Plan and prepare the carrier for the next try, then compose its spec. */
  private async prepareContinuedTry(
    facts: TryFacts,
    base: HarnessRunSpec,
    cause: ResumableCause,
    delayMs: number,
  ): Promise<AfterTryVerdict> {
    const composed = await composeContinuedTry(
      {
        deps: this.deps,
        capsule: this.capsule,
        acted: this.acted,
        nativeRejected: this.nativeRejected,
        tryIndex: this.tryIndex,
        uncertainInput: uncertainInputFor(this.deps.runDir, this.previousTryUnstarted),
      },
      facts,
      base,
      cause,
      delayMs,
    );
    this.continued = composed.continued;
    if (composed.capsule) this.capsule = composed.capsule;
    if (composed.moved && composed.capsule)
      discloseMovedSession(
        this.deps,
        composed.capsule,
        composed.moved.from,
        composed.moved.to,
        this.tryModel,
      );
    return composed.verdict;
  }

  private async relocate(runSpec: HarnessRunSpec): Promise<void> {
    if (this.capsule) this.capsule = await relocateCapsule(this.deps, this.capsule, runSpec);
  }

  /** The receipt of a continued try, emitted when the try settles (per-try model attestation). */
  private emitReceipt(runSpec: HarnessRunSpec): void {
    const continued = this.continued;
    if (!continued) return;
    this.continued = null;
    this.deps.emit("run.continuity", {
      harness_id: this.deps.adapter.id,
      attempt_id: this.deps.attemptId,
      session_id: runSpec.session_id,
      receipt: continuityReceipt({
        deps: this.deps,
        continued,
        tryIndex: this.tryIndex,
        requestedModel: this.tryRequestedModel,
        observedModel: this.tryModel,
        nativeRejected: this.nativeRejected,
        identity: this.tryIdentity,
        reingestedTokens: this.tryFirstInputTokens,
      }),
    });
  }
}

function codeOf(error: Error): string | null {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
