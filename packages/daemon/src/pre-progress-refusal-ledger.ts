import { credentialMutationWindowOpen } from "@claudexor/core";
import type { PreProgressRefusalObservation } from "@claudexor/schema";
import { PreProgressRefusalObservation as PreProgressRefusalObservationSchema } from "@claudexor/schema";
import { CredentialGeneration } from "./credential-generation.js";

/** Observation retention, not a vendor reset time: the refusal was read from
 * typed attempt evidence, never from prose, so it names no reset. One hour is
 * the bound the credential differential already gives a possibly model-scoped
 * refusal; a false mark costs only ordering. */
const TTL_MS = 60 * 60_000;
/** Bounded memory: the ledger holds evidence, not history. */
const MAX_ROWS = 64;

/**
 * The daemon's bounded, self-expiring memory of typed pre-progress refusals:
 * "this pool account's vendor session started for model M and ended in a
 * terminal refusal before any agent progress".
 *
 * The structural rotation already moves THAT run to a sibling without reading
 * the vendor's wording; without this memory the pool's deterministic order
 * puts the same refusing account first on every later unpinned run. A live
 * observation only ORDERS the pool for that requested model (INV-135): it never
 * excludes a row, never touches a pin or a usable bound account, and never
 * claims spent quota or a dead credential.
 *
 * Deliberately IN-MEMORY, like the ledgers beside it: a restart forgets every
 * mark and each account rediscovers its own refusal at the cost of one
 * rotation.
 *
 * Clearing contract:
 * 1. self-expiry — every row is stamped here with the one retention above;
 * 2. a served try — a later try on the same account and requested model that
 *    made agent progress or ended without an error clears that mark (`clear`);
 * 3. a credential-generation change voids the verdicts about the changed
 *    generation, at the unusable ledger's call sites: a login/logout clears the
 *    WHOLE ledger (`noteCredentialChange`), a control-API profile mutation
 *    clears PER SUBJECT (`clearSubject`). Neither waits for runs in flight, so
 *    each also moves the account's `generation`: a try binds it before its
 *    session spawns, and an outcome that arrives after a change neither
 *    recreates a voided mark nor clears the changed credential's newer one;
 * 4. while a login may be rewriting the harness's credential store (the
 *    daemon's setup-lifecycle window), the generation is NO number at all: a
 *    try bound inside the window, or one whose outcome lands inside it, is
 *    about a credential in flux and neither records nor clears (#363).
 */
export class PreProgressRefusalLedger {
  private rows = new Map<string, PreProgressRefusalObservation>();
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly mutating: (harnessId: string) => boolean = credentialMutationWindowOpen,
    readonly credentials: CredentialGeneration = new CredentialGeneration(mutating),
  ) {}

  /** Validate and stamp, newest-wins per (subject, requested model). */
  record(value: Omit<PreProgressRefusalObservation, "observed_at" | "expires_at">): void {
    if (this.mutating(value.harness_id)) return;
    const at = this.now().getTime();
    const obs = PreProgressRefusalObservationSchema.parse({
      ...value,
      observed_at: new Date(at).toISOString(),
      expires_at: new Date(at + TTL_MS).toISOString(),
    });
    this.prune();
    if (this.rows.size >= MAX_ROWS && !this.rows.has(key(obs))) {
      // Bounded: drop the earliest-expiring row rather than refusing evidence.
      const earliest = [...this.rows.entries()].reduce((a, b) =>
        Date.parse(a[1].expires_at) <= Date.parse(b[1].expires_at) ? a : b,
      );
      this.rows.delete(earliest[0]);
    }
    this.rows.set(key(obs), obs);
  }

  /** Every un-expired observation (the read side of account resolution). */
  live(): readonly PreProgressRefusalObservation[] {
    this.prune();
    return [...this.rows.values()];
  }

  /** The account served this requested model again: its mark is stale. */
  clear(harnessId: string, profileId: string, requestedModel: string | null): void {
    this.rows.delete(
      key({ harness_id: harnessId, profile_id: profileId, requested_model: requestedModel }),
    );
  }

  /** The account's credential generation: it moves only when a credential
   * change voids the account's verdicts, never with evidence or expiry. */
  generation(harnessId: string, profileId: string): number {
    return this.credentials.generation(harnessId, profileId);
  }

  /** Credential generation changed wholesale (login/logout): every verdict
   * about the old generation is void. */
  noteCredentialChange(): void {
    this.rows.clear();
    this.credentials.noteCredentialChange();
  }

  /** ONE account's credential changed (a control-API profile mutation): only
   * ITS verdicts are void, across every requested model. */
  clearSubject(harnessId: string, profileId: string): void {
    for (const [k, obs] of this.rows) {
      if (obs.harness_id === harnessId && obs.profile_id === profileId) this.rows.delete(k);
    }
    this.credentials.clearSubject(harnessId, profileId);
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [k, obs] of this.rows) {
      if (Date.parse(obs.expires_at) <= now) this.rows.delete(k);
    }
  }
}

function key(
  obs: Pick<PreProgressRefusalObservation, "harness_id" | "profile_id" | "requested_model">,
): string {
  // `\u0001` keeps the null default model distinct from a model named "".
  return [obs.harness_id, obs.profile_id, obs.requested_model ?? "\u0001"].join("\0");
}
