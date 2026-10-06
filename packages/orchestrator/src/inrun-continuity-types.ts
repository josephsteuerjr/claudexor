/** Inputs shared by the in-run controller and its I/O helpers. */
import type { AnswerAssembly, HarnessAdapter } from "@claudexor/core";
import type {
  CredentialProfile,
  HarnessRunSpec,
  QuotaSnapshot,
  RunEventType,
  RunResumable,
} from "@claudexor/schema";
import type { AttemptOutputMarkers } from "./attemptOutputMarkers.js";
import type { AttemptTelemetry, TransientFailureObservation } from "./attemptTelemetry.js";
import type { ModelGovernedRoute } from "./modelGovernance.js";
import type { ProfilePolicy, rotateSpecOnTypedLimit } from "./credential-profile-rotation.js";
import type { PreProgressRefusalSubject } from "./pre-progress-refusal.js";
import type { TransientRetryPolicy } from "./runSupport.js";

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
  workspace: RunResumable["workspace"];
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
  /** The model-governed route: an attested model is pinned only if it lists the id. */
  route?: ModelGovernedRoute;
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
  budgetStopped?: boolean;
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
