import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlGcReceipt,
  ControlGcRequest,
  ControlHarnessMaintenanceCreateRequest,
  ControlHarnessMaintenanceInventory,
  ControlHarnessMaintenanceOperation,
  Id,
} from "@claudexor/schema";
import type { OperationDraft } from "./operation-draft.js";
import { queryParam } from "./operation-parameters.js";
import { assertOnlyQueryParams, optionalBooleanQuery } from "./query.js";
import { requiredIdempotencyKey } from "./run-start.js";
import { routeValue, serviceResponse } from "./route-stages.js";

export interface MaintenanceRouteServices {
  /** One retention pass over engine-owned runtime artifacts (W3.6). */
  runRetention(request: ControlGcRequest): Promise<ControlGcReceipt>;
  /** Harness maintenance (harness-maintenance-service.ts): read-only facts. */
  maintenanceInventory(input: {
    harnessIds?: string[];
    fresh?: boolean;
    checkLatest?: boolean;
  }): Promise<unknown>;
  createMaintenanceOperation(
    request: ControlHarnessMaintenanceCreateRequest,
    idempotencyKey: string,
  ): Promise<unknown>;
  getMaintenanceOperation(id: string): Promise<unknown>;
  cancelMaintenanceOperation(id: string): Promise<unknown>;
}

export interface MaintenanceRouteContext {
  services?: Partial<MaintenanceRouteServices>;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown, fallbackStatus?: 400 | 500): void;
}

/** The maintenance route family's catalog entries, kept beside the routes. */
export const MAINTENANCE_OPERATION_DRAFTS: OperationDraft[] = [
  {
    method: "POST",
    path: "/v2/maintenance/gc",
    mutability: "mutating",
    requestSchema: "ControlGcRequest",
    responseSchema: "ControlGcReceipt",
    responseKind: "json",
    idempotency: "natural",
  },
  {
    method: "GET",
    path: "/v2/maintenance/harnesses",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlHarnessMaintenanceInventory",
    responseKind: "json",
    summary:
      "Inspect installed vendor CLIs: selected program and version, managed copy, tested pin and maintainability; never logs in or installs.",
    parameters: [
      queryParam({
        name: "harness",
        repeatable: true,
        description: "Restrict to these installable harness ids (repeat to select several).",
      }),
      queryParam({
        name: "fresh",
        enum: ["true", "false"],
        description: "Re-inspect instead of returning the cached installation facts.",
      }),
      queryParam({
        name: "checkLatest",
        enum: ["true", "false"],
        description:
          "Also read the newest published version where the mechanism supports it; omitted keeps the last observation (null = not checked).",
      }),
    ],
  },
  {
    method: "POST",
    path: "/v2/maintenance/operations",
    mutability: "mutating",
    requestSchema: "ControlHarnessMaintenanceCreateRequest",
    responseSchema: "ControlHarnessMaintenanceOperation",
    responseKind: "json",
    summary:
      "Accept one durable update/return of an installed vendor CLI; the 202 handle is not success.",
    idempotency: "key_required",
    completion: "durable_handle",
  },
  {
    method: "GET",
    path: "/v2/maintenance/operations/:id",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlHarnessMaintenanceOperation",
    responseKind: "json",
    summary: "Read one maintenance operation's lifecycle and before/target/after evidence.",
  },
  {
    method: "POST",
    path: "/v2/maintenance/operations/:id/cancel",
    mutability: "mutating",
    requestSchema: null,
    responseSchema: "ControlHarnessMaintenanceOperation",
    responseKind: "json",
    summary:
      "Cancel a maintenance operation; the installer's process tree is stopped and its effect disclosed.",
    idempotency: "natural",
  },
];

export async function handleMaintenanceRoute(
  ctx: MaintenanceRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const services = ctx.services;
  if (method === "POST" && path === "/maintenance/gc") {
    const service = services?.runRetention;
    if (!service) return false;
    const request = await routeValue(ctx, res, 400, async () =>
      ControlGcRequest.parse((await ctx.readBody(req)) ?? {}),
    );
    if (!request.ok) return true;
    const receipt = await routeValue(ctx, res, 500, () => service(request.value));
    if (!receipt.ok) return true;
    return serviceResponse(ctx, res, "runRetention", () =>
      ctx.json(res, 200, ControlGcReceipt.parse(receipt.value)),
    );
  }
  if (method === "GET" && path === "/maintenance/harnesses") {
    if (!services?.maintenanceInventory) return false;
    const input = await routeValue(ctx, res, 400, () => {
      const query = new URL(req.url ?? "/", "http://localhost");
      assertOnlyQueryParams(query, ["harness", "fresh", "checkLatest"]);
      const harnessIds = query.searchParams.getAll("harness");
      return {
        ...(harnessIds.length ? { harnessIds } : {}),
        fresh: optionalBooleanQuery(query, "fresh") === true,
        checkLatest: optionalBooleanQuery(query, "checkLatest") === true,
      };
    });
    if (!input.ok) return true;
    const value = await routeValue(ctx, res, 500, () =>
      services.maintenanceInventory!(input.value),
    );
    if (!value.ok) return true;
    return serviceResponse(ctx, res, "maintenanceInventory", () =>
      ctx.json(res, 200, ControlHarnessMaintenanceInventory.parse(value.value)),
    );
  }
  if (method === "POST" && path === "/maintenance/operations") {
    if (!services?.createMaintenanceOperation) return false;
    const input = await routeValue(ctx, res, 400, async () => ({
      key: requiredIdempotencyKey(req),
      body: ControlHarnessMaintenanceCreateRequest.parse(await ctx.readBody(req)),
    }));
    if (!input.ok) return true;
    const value = await routeValue(ctx, res, 500, () =>
      services.createMaintenanceOperation!(input.value.body, input.value.key),
    );
    if (!value.ok) return true;
    return serviceResponse(ctx, res, "createMaintenanceOperation", () =>
      ctx.json(res, 202, ControlHarnessMaintenanceOperation.parse(value.value)),
    );
  }
  const operationMatch = /^\/maintenance\/operations\/([^/]+)$/.exec(path);
  const cancelMatch = /^\/maintenance\/operations\/([^/]+)\/cancel$/.exec(path);
  let match: RegExpExecArray;
  let service: MaintenanceRouteServices["getMaintenanceOperation"] | undefined;
  if (method === "GET" && operationMatch) {
    match = operationMatch;
    service = services?.getMaintenanceOperation;
  } else if (method === "POST" && cancelMatch) {
    match = cancelMatch;
    service = services?.cancelMaintenanceOperation;
  } else return false;
  if (!service) return false;
  const id = await routeValue(ctx, res, 400, () => Id.parse(decodeURIComponent(match[1]!)));
  if (!id.ok) return true;
  const value = await routeValue(ctx, res, 500, () => service(id.value));
  if (!value.ok) return true;
  return serviceResponse(ctx, res, "maintenanceOperation", () =>
    ctx.json(res, 200, ControlHarnessMaintenanceOperation.parse(value.value)),
  );
}
