/**
 * The first try of a `continueFrom` successor (PLAN §2.3, INTERFACES §1 + §7).
 *
 * The in-run controller (`inrun-continuity.ts`) continues later tries of ONE
 * attempt; a successor run continues a terminal PREDECESSOR. Its first try is
 * planned here, once per run, through the same two planner functions: the
 * predecessor's session capsule, terminal `resumable` facts and evidence
 * decide the carrier; the spec is composed the way the controller composes a
 * continued try (a native carrier never resends the original prompt — the
 * notice plus the caller's text ride the user prompt; a packet re-briefs a
 * fresh session with the evidence index); the capsule is written into the
 * successor's attempt, so its later tries resume the same session; and the
 * controller is seeded with the predecessor's sticky `acted` and this try's
 * receipt (`from` = the predecessor, `same_root` / `different_root`), which
 * it emits when the try settles, with THIS try's attested model.
 *
 * A successor's work order is the chain's: the predecessor's work order plus
 * the caller's continuation text, recorded as `context/work-order.md` so the
 * next link reads one file instead of walking the chain.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import { readRunEvents, retainedOutput } from "@claudexor/event-log";
import {
  HarnessRunSpec as HarnessRunSpecSchema,
  RunResumable,
  RunTelemetry,
  type HarnessRunSpec,
  type ResumableCause,
  type SessionCapsule,
} from "@claudexor/schema";
import { readTextSafe } from "@claudexor/util";
import {
  decideCarrier,
  prepareCarrier,
  type CarrierFacts,
  type CarrierPreference,
} from "./carrier-planner.js";
import type { RunContinuation } from "./continuation-custody.js";
import { buildEvidenceIndex } from "./continuation-evidence.js";
import { collectEvidenceIndexInput, diffStatFromPatch } from "./continuation-evidence-io.js";
import { continuationNotice, packetContinuationPrompt } from "./continuity-notice.js";
import { InRunContinuity } from "./inrun-continuity.js";
import type { InRunContinuityDeps } from "./inrun-continuity-types.js";
import { uncertainInputFor, type ContinuedTry } from "./inrun-continuity-carrier.js";
import {
  readSessionCapsule,
  registryProfile,
  storeEnvFor,
  writeSessionCapsule,
} from "./session-capsule.js";

/** The predecessor a successor continues, resolved by the daemon from its own records. */
export interface ContinueFromSource {
  runId: string;
  /** Absolute run directory of the predecessor. */
  runDir: string;
  /** The lifecycle the predecessor ended with. */
  state: string;
  /** The predecessor's work order: every prompt of its chain, root first. */
  workOrder: string;
  preference: CarrierPreference;
}

const WORK_ORDER_FILE = join("context", "work-order.md");

const DIFFERENT_ROOT_NOTE =
  "This process runs in a different working tree than the previous one: check which of its changes are present here before continuing.";

/** What the predecessor left behind, read from its run directory. */
interface PredecessorFacts {
  /** Attempt whose evidence the index reads (the one holding the session, else the final one). */
  attemptId: string;
  capsule: SessionCapsule | null;
  resumable: RunResumable | null;
  cause: ResumableCause;
  acted: boolean;
  nativeRejected: boolean;
  observedModel: string | null;
  profileId: string | null;
  workOrder: string;
  output: string;
  diffStat: string | null;
  /** Execution root the predecessor's work lived in, when known. */
  root: string | null;
}

/** The capsule of the predecessor's session: the attempt matching the
 * terminal `resumable.session`, else the most recently located one. */
function heldSession(
  runDir: string,
  nativeSessionId: string | null,
): { attemptId: string; capsule: SessionCapsule } | null {
  const attemptsDir = join(runDir, "attempts");
  if (!existsSync(attemptsDir)) return null;
  const held = readdirSync(attemptsDir)
    .sort()
    .flatMap((attemptId) => {
      const capsule = readSessionCapsule(join(attemptsDir, attemptId));
      return capsule ? [{ attemptId, capsule }] : [];
    });
  return (
    held.find((entry) => entry.capsule.nativeSessionId === nativeSessionId) ??
    held.reduce<(typeof held)[number] | null>(
      (newest, entry) =>
        newest && (newest.capsule.mtimeMs ?? 0) > (entry.capsule.mtimeMs ?? 0) ? newest : entry,
      null,
    )
  );
}

function readPredecessor(store: ArtifactStore, from: ContinueFromSource): PredecessorFacts {
  const finalDir = join(from.runDir, "final");
  const resumable = RunResumable.safeParse(store.readYaml(join(finalDir, "resumable.yaml"))).data;
  const telemetry = RunTelemetry.safeParse(store.readYaml(join(finalDir, "telemetry.yaml"))).data;
  const held = heldSession(from.runDir, resumable?.session?.nativeSessionId ?? null);
  const attemptId = held?.attemptId ?? telemetry?.final_attempt_id ?? "a01";
  const attempt = telemetry?.attempts.find((entry) => entry.attempt_id === attemptId);
  const patch =
    readTextSafe(join(from.runDir, "attempts", attemptId, "patch.diff")) ??
    readTextSafe(join(finalDir, "patch.diff")) ??
    "";
  const events = readRunEvents(join(from.runDir, "events.jsonl"));
  const output =
    readTextSafe(join(finalDir, "answer.md"))?.trim() ||
    retainedOutput(events.events, events.malformed) ||
    "";
  const cause: ResumableCause =
    resumable?.cause ??
    (from.state === "interrupted"
      ? "host_restart"
      : from.state === "cancelled"
        ? "cancelled"
        : "other");
  return {
    attemptId,
    capsule: held?.capsule ?? null,
    resumable: resumable ?? null,
    cause,
    // Sticky `acted` of the predecessor: its terminal block lists `packet`
    // exactly when it acted; without the block, the evidence decides.
    acted: resumable
      ? resumable.carriers.includes("packet")
      : patch.trim().length > 0 || output.length > 0 || from.state === "succeeded",
    // The predecessor's controller dropped the session on a typed fact.
    nativeRejected: resumable !== undefined && resumable.session === null && held !== null,
    observedModel: attempt?.observed_model ?? held?.capsule.requestedModel ?? null,
    profileId: held?.capsule.holderProfileId ?? attempt?.profile_id ?? null,
    // What the predecessor itself was given, else the daemon's chain record.
    workOrder: readTextSafe(join(from.runDir, WORK_ORDER_FILE))?.trim() || from.workOrder,
    output,
    diffStat: diffStatFromPatch(patch),
    root: held?.capsule.cwd ?? resumable?.workspace.root ?? null,
  };
}

function samePath(a: string | null, b: string): boolean {
  if (a === null) return false;
  const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  return canonical(a) === canonical(b);
}

function profileRef(deps: InRunContinuityDeps, spec: HarnessRunSpec, profileId: string | null) {
  const row = registryProfile(deps.registry, profileId);
  return {
    profileId,
    env: storeEnvFor(spec.env, row),
    storeLocator: row?.isolation_locator ?? null,
  };
}

/**
 * Open the attempt's continuation controller. For the first candidate attempt
 * of a `continueFrom` successor, plan the carrier of its first try and return
 * the composed spec; every other attempt gets the controller unchanged.
 * `continuation.from` is consumed here: synthesis, a D-16d continuation or a
 * repair attempt of the same run never re-plans the predecessor's carrier.
 */
export async function openContinuity(
  deps: InRunContinuityDeps,
  first: { spec: HarnessRunSpec; continuation: RunContinuation | undefined; store: ArtifactStore },
): Promise<{ continuity: InRunContinuity; spec: HarnessRunSpec }> {
  const { spec, continuation, store } = first;
  const from = continuation?.from;
  if (!continuation || !from) return { continuity: new InRunContinuity(deps), spec };
  continuation.from = null;
  const pred = readPredecessor(store, from);
  const callerText = deps.workOrder;
  const workOrder = [pred.workOrder.trim(), callerText.trim()].filter(Boolean).join("\n\n");
  store.writeText(join(deps.runDir, WORK_ORDER_FILE), `${workOrder}\n`);
  // Another harness cannot resume this session: the evidence index carries it.
  const capsule = pred.capsule?.harness === deps.adapter.id ? pred.capsule : null;
  const targetId = spec.credential_profile?.profile_id ?? null;
  const sourceId = capsule ? capsule.holderProfileId : targetId;
  const facts: CarrierFacts = {
    capsule,
    acted: pred.acted,
    cause: pred.cause,
    sourceProfile: profileRef(deps, spec, sourceId),
    targetProfile: profileRef(deps, spec, targetId),
    effectiveModel: pred.observedModel ?? spec.model_hint ?? null,
    preference: from.preference,
    adapter: deps.adapter,
    nativeRejected: pred.nativeRejected,
  };
  const evidence = {
    runDir: from.runDir,
    attemptId: pred.attemptId,
    workOrder: pred.workOrder,
    steering: [],
  };
  const extras = { cause: pred.cause, retainedOutput: pred.output, diffStat: pred.diffStat };
  const prepared = await prepareCarrier(decideCarrier(facts), {
    facts,
    evidence,
    targetCwd: deps.cwd,
    retainedOutput: pred.output,
    diffStat: pred.diffStat,
  });
  const uncertainInput = uncertainInputFor(from.runDir, null, pred.attemptId);
  const sameRoot = samePath(pred.root, deps.cwd);
  // The notice says the workspace is as it was left; in another tree that is
  // not known, so the child is told to check before relying on it.
  const treeNote = sameRoot ? "" : DIFFERENT_ROOT_NOTE;
  const withNote = (text: string) => [treeNote, text.trim()].filter(Boolean).join("\n\n");
  const native = prepared.carrier === "native" || prepared.carrier === "native_moved";
  let composed: HarnessRunSpec;
  if (prepared.carrier === "native" || prepared.carrier === "native_moved") {
    writeSessionCapsule(deps.attemptDir, prepared.capsule);
    try {
      await prepared.retire?.();
    } catch {
      // The published capsule is authoritative even if a stale source copy remains.
    }
    // A follow-up on finished work is the caller's text alone; unfinished
    // work gets the continuation notice (cause, undelivered input) first.
    const followUp = pred.resumable === null && from.state === "succeeded" && callerText.trim();
    composed = HarnessRunSpecSchema.parse({
      ...spec,
      resume_session_id: prepared.resumeRef.nativeSessionId,
      prompt: followUp
        ? withNote(callerText)
        : continuationNotice({
            cause: pred.cause,
            uncertainInput,
            callerText: withNote(callerText),
          }),
    });
  } else {
    // `fresh` (the predecessor did not act) still needs the work order: the
    // same index is the brief, it simply carries no work.
    const index =
      prepared.carrier === "packet"
        ? prepared.packet
        : buildEvidenceIndex(collectEvidenceIndexInput(evidence, extras));
    const dir = join(deps.attemptDir, "continuation");
    mkdirSync(dir, { recursive: true });
    const evidencePath = join(dir, "evidence-index-try0.md");
    writeFileSync(evidencePath, index.markdown);
    composed = HarnessRunSpecSchema.parse({
      ...spec,
      resume_session_id: null,
      // A null model hint must not re-resolve to another default on a new session (§7.1).
      model_hint: spec.model_hint ?? facts.effectiveModel,
      prompt: packetContinuationPrompt({
        originalPrompt: spec.prompt,
        notice: continuationNotice({ cause: pred.cause, uncertainInput, callerText: withNote("") }),
        evidencePath,
        evidenceMarkdown: index.markdown,
      }),
    });
  }
  const continued: ContinuedTry = {
    carrier: prepared.carrier,
    summarized: prepared.carrier === "packet" && prepared.packet.summarized,
    cause: pred.cause,
    fromProfileId: capsule ? capsule.holderProfileId : pred.profileId,
    toProfileId: targetId,
    memory: native ? "full" : "partial",
    inputDelivery: uncertainInput === null ? "confirmed" : "uncertain",
    from: { runId: from.runId, attemptId: pred.attemptId },
    workspace: sameRoot ? "same_root" : "different_root",
  };
  return {
    continuity: new InRunContinuity({ ...deps, workOrder, seed: { acted: pred.acted, continued } }),
    spec: composed,
  };
}
