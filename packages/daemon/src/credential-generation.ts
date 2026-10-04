import {
  credentialMutationWindowOpen,
  type CredentialExecutionBinding,
  type CredentialExecutionSubject,
} from "@claudexor/core";

/** Extracted from the pre-progress ledger: one managed lifecycle for all observations. */
export class CredentialGeneration {
  private changes = 0;
  private everyAccountChangedAt = 0;
  private defaultChangedAt = 0;
  private accountChangedAt = new Map<string, number>();
  private dispatchOrder = 0;

  constructor(
    private readonly mutating: (harnessId: string) => boolean = credentialMutationWindowOpen,
  ) {}

  generation(harnessId: string, profileId: string | null): number {
    if (this.mutating(harnessId)) return Number.NaN;
    return Math.max(
      this.everyAccountChangedAt,
      profileId === null ? this.defaultChangedAt : 0,
      this.accountChangedAt.get(key(harnessId, profileId)) ?? 0,
    );
  }

  bind(subject: CredentialExecutionSubject, startedAt = new Date().toISOString()): CredentialExecutionBinding {
    return {
      subject,
      generation: this.generation(subject.harnessId, subject.profileId),
      order: ++this.dispatchOrder,
      startedAt,
    };
  }

  current(binding: CredentialExecutionBinding): boolean {
    return (
      this.generation(binding.subject.harnessId, binding.subject.profileId) === binding.generation
    );
  }

  noteCredentialChange(): void {
    this.accountChangedAt.clear();
    this.everyAccountChangedAt = ++this.changes;
  }

  clearSubject(harnessId: string, profileId: string | null): void {
    this.accountChangedAt.set(key(harnessId, profileId), ++this.changes);
  }

  clearDefaultSubjects(): void {
    this.defaultChangedAt = ++this.changes;
  }
}

function key(harnessId: string, profileId: string | null): string {
  return `${harnessId}\0${profileId ?? "\u0001"}`;
}
