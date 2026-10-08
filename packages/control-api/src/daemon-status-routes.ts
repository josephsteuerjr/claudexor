import type { IncomingMessage, ServerResponse } from "node:http";
import { ControlDaemonStatus } from "@claudexor/schema";
import type { DaemonFacadeClient } from "./run-record.js";
import type { MaintenanceRouteContext } from "./maintenance-routes.js";

export async function handleDaemonStatusRoute(
  ctx: MaintenanceRouteContext & { daemon: DaemonFacadeClient },
  method: string,
  path: string,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method === "GET" && path === "/daemon/status") {
    if (!ctx.daemon.health) return false;
    try {
      ctx.json(res, 200, ControlDaemonStatus.parse(await ctx.daemon.health()));
    } catch (error) {
      ctx.requestError(res, error, 500);
    }
    return true;
  }
  return false;
}
