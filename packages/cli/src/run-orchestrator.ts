/**
 * ONE construction owner for the daemon's per-run Orchestrator, hoisted from
 * `claudexord` so the credential-evidence wiring (A7) lives beside the quota
 * wiring it siblings: the same event stream that feeds the quota registry
 * feeds the unusable-credential ledger's success-clearing, and the same deps
 * boundary that injects quota snapshots injects the ledger's observations.
 */
import {
  CredentialUnusableLedger,
  CredentialGeneration,
  PreProgressRefusalLedger,
  logPath,
  type QuotaRegistry,
} from "@claudexor/daemon";
import { Orchestrator, createCredentialExecutionObserver } from "@claudexor/orchestrator";
import type { normalizeRunStartRequest } from "@claudexor/control-api";
import { buildRegistry } from "./registry.js";
import type { RuntimeConcurrencyCaps } from "@claudexor/schema";
import { logLine } from "./daemon-lifecycle.js";

/**
 * Daemon-lifetime typed `credential_unusable` evidence (A7): in-memory and
 * bounded by design — the poller re-derives vendor rejections within a cycle
 * after a restart, and a restart usually follows the re-login that heals a
 * dead credential. `claudexord` clears it on credential-generation changes.
 */
const credentialGeneration = new CredentialGeneration();
export const credentialUnusableLedger = new CredentialUnusableLedger(
  undefined,
  undefined,
  credentialGeneration,
);

/**
 * Daemon-lifetime pre-progress refusal observations (#363): in-memory and
 * bounded like the unusable ledger, cleared at the same credential-generation
 * call sites. Agent Runs produce them and every unpinned pool choice (runs,
 * reviewers, the Accounts `next_up` projection) reads them.
 */
export const preProgressRefusalLedger = new PreProgressRefusalLedger(
  undefined,
  undefined,
  credentialGeneration,
);

type OrchestratorDeps = ConstructorParameters<typeof Orchestrator>[0];

export function buildRunOrchestrator(args: {
  p: ReturnType<typeof normalizeRunStartRequest>;
  delegationBudgetAuthority: OrchestratorDeps["delegationBudgetAuthority"];
  quotaStore: () => QuotaRegistry;
  /** Typed per-harness refusal while a unified-accounts migration is
   * incomplete (a crash between phases) — other harnesses keep working. */
  accountsMigrationGate?: OrchestratorDeps["accountsMigrationGate"];
  runtimeConcurrencyCaps?: RuntimeConcurrencyCaps;
}): Orchestrator {
  const { p, quotaStore } = args;
  return new Orchestrator({
    registry: buildRegistry(),
    delegationBudgetAuthority: args.delegationBudgetAuthority,
    accountsMigrationGate: args.accountsMigrationGate,
    routingGoal: p.routingGoal,
    quotaSnapshots: () => quotaStore().read().snapshots,
    // The absence half of the SAME projection: `auth_revoked` is how the
    // poller reports a vendor rejecting a profile's credential, and run
    // admission is the surface that has to act on it.
    quotaAbsences: () => quotaStore().read().absences,
    credentialObserverFactory: (subject) => {
      const binding = credentialUnusableLedger.bind(subject);
      const observer = createCredentialExecutionObserver(credentialUnusableLedger, binding);
      const maintain = (operation: () => void) => {
        try {
          operation();
        } catch (error) {
          logLine(
            logPath(),
            `account observation failed (${subject.harnessId}/${subject.profileId ?? "default"}): ${String(error)}`,
          );
        }
      };
      return {
        observe: (event) =>
          maintain(() => {
            observer.observe(event);
            // A late native event cannot restore quota from before a managed
            // credential change. The stream itself remains fully observable.
            const sameProfile =
              event.credential_profile_id === undefined ||
              event.credential_profile_id === subject.profileId;
            const sameRoute =
              subject.route === null ||
              event.credential_route === undefined ||
              event.credential_route === subject.route;
            if (sameProfile && sameRoute && credentialUnusableLedger.current(binding)) {
              quotaStore().ingest(subject.harnessId, {
                ...event,
                credential_profile_id: subject.profileId,
                ...(event.credential_route === undefined && subject.route !== null
                  ? { credential_route: subject.route }
                  : {}),
              });
            }
          }),
        finish: () => maintain(() => observer.finish()),
      };
    },
    credentialUnusable: () => credentialUnusableLedger.live(),
    credentialEvidence: credentialUnusableLedger,
    preProgressRefusals: preProgressRefusalLedger,
    reviewerPanel: p.reviewerPanel,
    reviewerModels:
      p.reviewerModels && typeof p.reviewerModels === "object" ? p.reviewerModels : undefined,
    reviewerEfforts:
      p.reviewerEfforts && typeof p.reviewerEfforts === "object" ? p.reviewerEfforts : undefined,
    runtimeConcurrencyCaps: args.runtimeConcurrencyCaps,
  });
}
