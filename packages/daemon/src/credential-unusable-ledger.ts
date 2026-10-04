import {
  credentialMutationWindowOpen,
  type CredentialEvidenceAuthority,
  type CredentialExecutionBinding,
  type CredentialExecutionSubject,
  type CredentialHonoredObservation,
} from "@claudexor/core";
import type { CredentialUnusableObservation } from "@claudexor/schema";
import { CredentialUnusableObservation as CredentialUnusableObservationSchema } from "@claudexor/schema";
import { CredentialGeneration } from "./credential-generation.js";

/** No observation may outlive this bound, whatever its producer asked for. */
const MAX_TTL_MS = 24 * 60 * 60_000;
/** Bounded memory: the ledger holds evidence, not history. */
const MAX_ROWS = 64;

interface Success {
  binding: CredentialExecutionBinding;
  observation: CredentialHonoredObservation;
  order: number;
  expires: number;
}

/**
 * The daemon's bounded, self-expiring memory of typed `credential_unusable`
 * observations (A7): "this credential is DEAD, not quota-spent".
 *
 * Deliberately IN-MEMORY, never journaled: profile readiness is non-durable by
 * contract (the doctor's projection), the quota poller re-derives vendor
 * rejections within a poll cycle after a restart, and a restart usually
 * follows exactly the re-login that heals a dead credential — journaling would
 * buy rollback-compat risk to preserve evidence that expires anyway. The
 * `QuotaAbsence` channel is unsuitable on purpose: the registry hides an
 * absence while ANY live snapshot covers the subject, which is exactly how a
 * dead credential with a lingering cooldown snapshot would vanish.
 *
 * Clearing contract (all three, per the design roast):
 * 1. self-expiry — every row carries `expires_at`, clamped to 24h max;
 * 2. a covering dispatch-bound successful model response hides the live
 *    verdict; its bounded negative witnesses remain until expiry or generation
 *    clearing so a later concurrent refusal cannot lose either boundary;
 * 3. a credential-generation change voids the verdicts about the changed
 *    generation: a login/logout clears the WHOLE ledger
 *    (`noteCredentialChange`, wired in claudexord's setup lifecycle), while a
 *    control-API credential mutation (profile enable/disable/create/remove,
 *    secret set/delete) clears PER SUBJECT (`clearSubject` /
 *    `clearDefaultSubjects`, wired beside the daemon's status-cache busting).
 *    Clearing is always fail-open — a lost observation costs at
 *    most one attempt rediscovering a refusal, while a stale one poisons
 *    rotation;
 * 4. no verdict is recorded while a login may be rewriting that harness's
 *    credential store (the daemon's setup-lifecycle window, #363): it would be
 *    about a credential in flux, and the window's close clears the ledger.
 */
export class CredentialUnusableLedger implements CredentialEvidenceAuthority {
  private rows = new Map<string, CredentialUnusableObservation>();
  private orders = new Map<string, number>();
  private successes = new Map<string, Success[]>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly mutating: (harnessId: string) => boolean = credentialMutationWindowOpen,
    readonly credentials: CredentialGeneration = new CredentialGeneration(mutating),
  ) {}

  bind(subject: CredentialExecutionSubject): CredentialExecutionBinding {
    return this.credentials.bind(subject, this.now().toISOString());
  }

  current(binding: CredentialExecutionBinding): boolean {
    return this.credentials.current(binding);
  }

  recordBound(binding: CredentialExecutionBinding, value: CredentialUnusableObservation): void {
    if (!this.current(binding)) return;
    if (
      value.harness_id !== binding.subject.harnessId ||
      value.profile_id !== binding.subject.profileId
    )
      return;
    if (
      value.credential_route !== undefined &&
      binding.subject.route !== null &&
      value.credential_route !== binding.subject.route
    )
      return;
    // Even a healed prefix contributes to a later concurrent refusal's bounds.
    this.store(value, binding.order);
  }

  /** A dispatch cannot heal an observation from a newer concurrent dispatch. */
  honorBound(
    binding: CredentialExecutionBinding,
    observedModel: string | null,
    observedAt = this.now().toISOString(),
  ): void {
    if (!this.current(binding)) return;
    const observedTime = Date.parse(observedAt);
    if (!Number.isFinite(observedTime)) return;
    // A cached result predating dispatch proves no current-generation contact.
    if (observedTime < Date.parse(binding.startedAt)) return;
    this.prune();
    for (const model of observedModel === null ? [null] : [null, observedModel]) {
      const k = key({
        harness_id: binding.subject.harnessId,
        profile_id: binding.subject.profileId,
        credential_route: binding.subject.route ?? undefined,
        model,
      });
      const point: Success = {
        binding,
        observation: {
          harness_id: binding.subject.harnessId,
          profile_id: binding.subject.profileId,
          credential_route: binding.subject.route,
          model,
          observed_at: observedAt,
        },
        order: binding.order,
        expires: this.now().getTime() + MAX_TTL_MS,
      };
      const previous = this.successes.get(k) ?? [];
      if (previous.some((item) => dominates(item, point))) continue;
      // Keep real incomparable contacts, never a synthetic order/time maximum.
      this.successes.set(k, [...previous.filter((item) => !dominates(point, item)), point]);
    }
    // Count points, not keys: a single subject can have incomparable contacts.
    while (this.positivePoints().length > MAX_ROWS) {
      const oldest = [...this.successes.entries()]
        .flatMap(([k, points]) => points.map((point) => ({ k, point })))
        .reduce((a, b) => (a.point.expires <= b.point.expires ? a : b));
      const retained = this.successes.get(oldest.k)!.filter((point) => point !== oldest.point);
      if (retained.length) this.successes.set(oldest.k, retained);
      else this.successes.delete(oldest.k);
    }
  }

  /** Validate, clamp to the TTL bound, newest-wins per (subject, model). */
  record(value: CredentialUnusableObservation): void {
    const binding = this.bind({
      harnessId: value.harness_id,
      profileId: value.profile_id,
      route: value.credential_route ?? null,
      requestedModel: value.model,
    });
    this.recordBound(binding, value);
  }

  private store(value: CredentialUnusableObservation, order: number): void {
    const obs = CredentialUnusableObservationSchema.parse(value);
    if (this.mutating(obs.harness_id)) return;
    const observed = Date.parse(obs.observed_at);
    const cap = (Number.isFinite(observed) ? observed : this.now().getTime()) + MAX_TTL_MS;
    const expires = Math.min(Date.parse(obs.expires_at), cap);
    this.prune();
    if (!Number.isFinite(expires) || expires <= this.now().getTime()) return;
    if (this.rows.size >= MAX_ROWS && !this.rows.has(key(obs))) {
      // Bounded: drop the earliest-expiring row rather than refusing evidence.
      const earliest = [...this.rows.entries()].reduce((a, b) =>
        Date.parse(a[1].expires_at) <= Date.parse(b[1].expires_at) ? a : b,
      );
      this.rows.delete(earliest[0]);
      this.orders.delete(earliest[0]);
    }
    const k = key(obs);
    const previous = this.rows.get(k);
    const previousTime = previous ? Date.parse(previous.observed_at) : -Infinity;
    const previousOrder = this.orders.get(k) ?? order;
    // A delayed completion cannot lower either independent negative boundary.
    // Provenance and expiry belong to the latest actual observation, not arrival.
    // Preserve the prior equal-time provenance against an older dispatch.
    if (observed > previousTime || (observed === previousTime && order >= previousOrder))
      this.rows.set(k, { ...obs, expires_at: new Date(expires).toISOString() });
    this.orders.set(k, Math.max(previousOrder, order));
  }

  /** Unhealed observations; hidden witnesses keep their bounds until expiry. */
  live(): readonly CredentialUnusableObservation[] {
    this.prune();
    const positives = this.positivePoints();
    return [...this.rows.entries()]
      .filter(([k, obs]) => !positives.some((point) => this.covers(k, obs, point)))
      .map(([, obs]) => obs);
  }

  honored(): readonly CredentialHonoredObservation[] {
    this.prune();
    return this.positivePoints()
      .filter(
        (entry) =>
          this.current(entry.binding) &&
          !this.refusesPositive(
            entry.binding,
            entry.observation.model,
            Date.parse(entry.observation.observed_at),
          ),
      )
      .map((entry) => ({ ...entry.observation }));
  }

  /** Exported proof obeys the same scope/order checks as row clearing. */
  private refusesPositive(
    binding: CredentialExecutionBinding,
    model: string | null,
    observedTime: number,
  ): boolean {
    for (const [k, refusal] of this.rows) {
      if (!matches(refusal, binding.subject, model)) continue;
      if (
        (this.orders.get(k) ?? Infinity) > binding.order ||
        Date.parse(refusal.observed_at) > observedTime
      )
        return true;
    }
    return false;
  }

  private covers(k: string, refusal: CredentialUnusableObservation, point: Success): boolean {
    return (
      matches(refusal, point.binding.subject, point.observation.model) &&
      (this.orders.get(k) ?? Infinity) <= point.order &&
      Date.parse(refusal.observed_at) <= Date.parse(point.observation.observed_at)
    );
  }

  private positivePoints(): Success[] {
    return [...this.successes.values()].flat();
  }

  /** Credential generation changed wholesale (login/logout): every verdict
   * about the old generation is void. */
  noteCredentialChange(): void {
    this.rows.clear();
    this.orders.clear();
    this.successes.clear();
    this.credentials.noteCredentialChange();
  }

  /** ONE subject's credential changed (a control-API profile or profile-secret
   * mutation): only ITS verdicts are void, across every model scope.
   * `profileId` null = the harness's default subject. */
  clearSubject(harnessId: string, profileId: string | null): void {
    for (const k of this.successes.keys())
      if (k.startsWith([harnessId, profileId ?? "", ""].join("\0"))) this.successes.delete(k);
    for (const [k, obs] of this.rows) {
      if (obs.harness_id === harnessId && obs.profile_id === profileId) {
        this.rows.delete(k);
        this.orders.delete(k);
      }
    }
    this.credentials.clearSubject(harnessId, profileId);
  }

  /** A bare managed secret name changed an engine-DEFAULT credential slot.
   * WHICH harness reads that slot is adapter knowledge the daemon does not
   * duplicate, so every default subject's verdicts are voided — fail-open by
   * the clearing contract (costs at most one rediscovered refusal). */
  clearDefaultSubjects(): void {
    this.credentials.clearDefaultSubjects();
    for (const k of this.successes.keys()) if (k.split("\0")[1] === "") this.successes.delete(k);
    for (const [k, obs] of this.rows) {
      if (obs.profile_id === null) {
        this.rows.delete(k);
        this.orders.delete(k);
      }
    }
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [k, points] of this.successes) {
      const retained = points.filter((point) => point.expires > now && this.current(point.binding));
      if (retained.length) this.successes.set(k, retained);
      else this.successes.delete(k);
    }
    for (const [k, obs] of this.rows) {
      const expires = Date.parse(obs.expires_at);
      if (!Number.isFinite(expires) || expires <= now) {
        this.rows.delete(k);
        this.orders.delete(k);
      }
    }
  }
}

function matches(
  refusal: CredentialUnusableObservation,
  subject: CredentialExecutionSubject,
  model: string | null,
): boolean {
  return (
    refusal.harness_id === subject.harnessId &&
    refusal.profile_id === subject.profileId &&
    (refusal.credential_route === undefined || refusal.credential_route === subject.route) &&
    (refusal.model === null || refusal.model === model)
  );
}

function dominates(left: Success, right: Success): boolean {
  return (
    left.order >= right.order &&
    Date.parse(left.observation.observed_at) >= Date.parse(right.observation.observed_at)
  );
}

function key(
  obs: Pick<
    CredentialUnusableObservation,
    "harness_id" | "profile_id" | "credential_route" | "model"
  >,
): string {
  return [obs.harness_id, obs.profile_id ?? "", obs.credential_route ?? "", obs.model ?? ""].join(
    "\0",
  );
}
