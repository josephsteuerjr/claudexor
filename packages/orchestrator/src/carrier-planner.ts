/**
 * Carrier planner (the "continue from the break point" ladder) — the ONE seam
 * both the in-run continuation loop (later tries of an attempt) and the
 * `continueFrom` run chain (first try of a successor run) call.
 *
 * Two functions, deliberately separate: `decideCarrier` is PURE over explicit
 * facts and yields the ordered ladder of carriers to try; `prepareCarrier`
 * does the I/O for that ladder — it locates the session, moves it into the
 * target account's store, or builds the evidence index — and returns the
 * first rung that works. Harness-specific mechanics stay behind the adapter's
 * `continuity` capability; the planner never reads vendor prose (INV-049).
 */
import type { EnvMap, HarnessAdapter } from "@claudexor/core";
import type { ContinuityCarrier, ResumableCause, SessionCapsule } from "@claudexor/schema";
import type { EvidenceIndex, EvidenceIndexSources } from "./continuation-evidence.js";

export type CarrierPreference = "auto" | "packet";

/** Where a session lives now (source) or will run next (target). */
export interface CarrierProfileRef {
  profileId: string | null;
  /** The env the child sees on that account (the spec env). */
  env: EnvMap;
  /** The registry row's `isolation_locator`; null = the harness default store. */
  storeLocator: string | null;
}

export interface CarrierFacts {
  /** This attempt's capsule (in-run) or the predecessor's (`continueFrom`); null = no native session known. */
  capsule: SessionCapsule | null;
  /** Sticky per attempt: the predecessor did work (accepted answer text, agent
   * progress, a file change or a workspace diff in ANY try). Never recomputed
   * from the last try alone. */
  acted: boolean;
  cause: ResumableCause;
  sourceProfile: CarrierProfileRef;
  targetProfile: CarrierProfileRef;
  /** The attested model to keep (a null `model_hint` must not re-resolve to another default). */
  effectiveModel: string | null;
  preference: CarrierPreference;
  adapter: Pick<HarnessAdapter, "id" | "continuity">;
  /** A TYPED fact already proved the native carrier unusable on this session
   * (identity mismatch at the handshake, or the adapter's typed rejection of
   * carried state): the native rungs are skipped. */
  nativeRejected: boolean;
}

export interface CarrierDecision {
  /** Ordered rungs; `prepareCarrier` returns the first that works. Never
   * contains `fresh` after `acted` (a partially-acted attempt never replays). */
  ladder: ContinuityCarrier[];
  /** True when the target account differs from the source (a hop). */
  hop: boolean;
  effectiveModel: string | null;
  /** Machine-stable reason for the ladder shape (disclosure, not governance). */
  reason: string;
}

export interface CarrierIo {
  facts: CarrierFacts;
  /** Sources of the evidence index (the run dir, the work order, admitted steering). */
  evidence: EvidenceIndexSources;
  targetCwd: string;
}

export type CarrierPrepared =
  | {
      carrier: "native" | "native_moved";
      resumeRef: { nativeSessionId: string; path?: string };
      /** The capsule after location/move: the current holder. */
      capsule: SessionCapsule;
    }
  | { carrier: "packet"; packet: EvidenceIndex }
  | { carrier: "fresh" };

/** Pure: the ordered ladder of carriers for these facts. */
export function decideCarrier(_facts: CarrierFacts): CarrierDecision {
  throw new Error("decideCarrier is not wired yet (interfaces freeze)");
}

/** I/O: walk the ladder — locate, move, or build the evidence index — and return the first rung that works. */
export async function prepareCarrier(
  _decision: CarrierDecision,
  _io: CarrierIo,
): Promise<CarrierPrepared> {
  throw new Error("prepareCarrier is not wired yet (interfaces freeze)");
}
