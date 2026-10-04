import type { CredentialUnusableLedger, QuotaRegistry } from "@claudexor/daemon";
import { createCredentialExecutionObserver } from "@claudexor/orchestrator";
import type { ControlProblem, HarnessEvent, ModelUsage } from "@claudexor/schema";

/** Bind at the real catalog/inference boundary, before any provider work.
 * Raw models translate their typed result into the same observation owner
 * as native sessions; the original result and dispatch custody are unchanged. */
export function bindModelAccountEvidence(args: {
  harnessId: string;
  profileId: string;
  model: string | null;
  unusable: CredentialUnusableLedger;
  quota: () => QuotaRegistry;
}) {
  const binding = args.unusable.bind({
    harnessId: args.harnessId,
    profileId: args.profileId,
    route: "vendor_native",
    requestedModel: args.model,
  });
  const observer = createCredentialExecutionObserver(args.unusable, binding);
  return {
    current: () => args.unusable.current(binding),
    honorCatalog: (observedAt: string) => args.unusable.honorBound(binding, null, observedAt),
    finish: () => observer.finish(),
    observe: (
      problem: ControlProblem | null,
      usage?: ModelUsage,
      model?: string | null,
      dispatched = false,
    ) => {
      const event: HarnessEvent = {
        type: usage ? "usage" : "error",
        ts: new Date().toISOString(),
        session_id: "model-operation",
        credential_route: "vendor_native",
        credential_profile_id: args.profileId,
        observed_model: model ?? undefined,
        ...(usage
          ? {
              usage: {
                input_tokens: usage.input_tokens ?? undefined,
                output_tokens: usage.output_tokens ?? undefined,
                cached_input_tokens: usage.cached_input_tokens ?? undefined,
              },
            }
          : {}),
      };
      const context = problem?.context ?? {};
      if (typeof context.resetsAt === "string" || typeof context.retryAfterMs === "number") {
        event.rate_limit = {
          resets_at: typeof context.resetsAt === "string" ? context.resetsAt : null,
          retry_delay_ms: typeof context.retryAfterMs === "number" ? context.retryAfterMs : null,
        };
      }
      observer.observe(event);
      // model_unavailable also names local preparation/catalog failures.
      // Only a dispatched generation's typed refusal can condemn that model.
      const category =
        problem?.code === "auth_required"
          ? "authentication_failed"
          : dispatched && args.model !== null && problem?.code === "model_unavailable"
            ? "model_not_found"
            : null;
      if (category) {
        observer.observe({
          ...event,
          type: "error",
          usage: undefined,
          rate_limit: undefined,
          status: { kind: "api_retry", error_category: category },
        });
      }
      observer.observe({
        ...event,
        type: "completed",
        usage: undefined,
        rate_limit: undefined,
        payload: { exit_code: problem ? 1 : 0, harness_reported_error: problem !== null },
      });
      if (args.unusable.current(binding)) args.quota().ingest(args.harnessId, event);
    },
  };
}
