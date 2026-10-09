/** /v2/quota control services over the daemon's QuotaRegistry. */
import type { QuotaRegistry } from "@claudexor/daemon";
import {
  ControlQuotaRefreshRequest,
  withQuotaAvailability,
  type ControlQuotaResponse,
  type ControlAccountResourcesResponse,
  type AccountResourceSnapshot,
} from "@claudexor/schema";
import { accountManagementTarget } from "./account-management.js";

export function accountResourcesResponse(
  registry: QuotaRegistry,
  response: ControlQuotaResponse = registry.read(),
  resources: AccountResourceSnapshot[] = registry.readResources(),
): ControlAccountResourcesResponse {
  return { ...withQuotaAvailability(response), resources };
}

/** Compatibility text belongs at the old wire boundary, never in canonical
 * quota evidence or admission. Rich clients get typed reset inventory only. */
export function legacyQuotaResponse(
  registry: QuotaRegistry,
  response: ControlQuotaResponse,
  resources = registry.readResources?.() ?? [],
): ControlQuotaResponse {
  const decorated = withQuotaAvailability(response);
  return {
    ...decorated,
    snapshots: decorated.snapshots.map((snapshot) => {
      const row = resources.find(
        (row) =>
          row.target.harness === snapshot.subject.harness &&
          row.target.profile_id === snapshot.subject.subject_id,
      );
      const count = row?.resets.value?.find(
        (offer) => offer.id === "codex_granted",
      )?.available_count;
      return typeof count === "number" && count > 0 && snapshot.source === "codex_app_server"
        ? {
            ...snapshot,
            constraints: [
              ...snapshot.constraints.filter((constraint) => constraint.id !== "reset_credits"),
              {
                id: "reset_credits",
                label: `${count} reset credit${count === 1 ? "" : "s"} available`,
                used_ratio: null,
                window_seconds: null,
                resets_at: null,
                cooldown_until: null,
              },
            ],
          }
        : snapshot;
    }),
  };
}

/** Bind GET/POST /v2/quota to the registry. Both routes decorate each snapshot
 * with the derived model-aware availability projection at the response
 * boundary; the registry's own read()/journal/projection-signature stay
 * byte-identical. The atomic Accounts response uses the same decorator at its
 * own boundary. POST accepts an optional model to compute state against. */
export function quotaControlServices(quotaRegistry: () => QuotaRegistry) {
  return {
    quota: async (input?: { view?: "resources" }) =>
      input?.view === "resources"
        ? accountResourcesResponse(quotaRegistry())
        : legacyQuotaResponse(quotaRegistry(), quotaRegistry().read()),
    refreshQuota: async (input?: ControlQuotaRefreshRequest & { view?: "resources" }) => {
      const { view, ...body } = input ?? {};
      const request = ControlQuotaRefreshRequest.parse(body);
      if (request.target) accountManagementTarget(request.target);
      if (view === "resources") {
        const result = await quotaRegistry().refreshResources(request.target);
        return {
          ...withQuotaAvailability(result, { model: request.model }),
          resources: result.resources,
        };
      }
      return withQuotaAvailability(
        legacyQuotaResponse(quotaRegistry(), await quotaRegistry().refresh(request.target)),
        { model: request.model },
      );
    },
  };
}
