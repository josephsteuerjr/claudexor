import { connectDaemonIfRunning, ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { BELT_DAEMON_LOST } from "./mcp-daemon-unavailable.js";

export async function catalogQuery(
  mode: "__status" | "__capabilities" | "__accounts",
  beltContext = false,
  options: { fresh?: boolean } = {},
): Promise<Record<string, unknown>> {
  const connection = beltContext ? await connectDaemonIfRunning() : await ensureDaemon();
  if (!connection) throw new Error(BELT_DAEMON_LOST);
  const { addr } = connection;
  // __accounts retains the first readiness acquisition with its age and
  // composes current quota/registry facts. The explicit snapshot refresh does a
  // live probe per profile, a full doctor sweep, and the vendor quota
  // fan-out — and is requested only by fresh:true (which itself honors the
  // subject rate-limit cooldowns and retained legacy vendor floors).
  const path =
    mode === "__status"
      ? "/harnesses"
      : mode === "__accounts"
        ? options.fresh === true
          ? "/credential-profiles?snapshot=true"
          : "/credential-profiles"
        : "/agent-capabilities";
  const response = await controlApiFetch(addr, path);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(`control API ${path} failed (HTTP ${response.status})`);
  if (mode !== "__status") return body;
  const harnesses = Array.isArray(body["harnesses"])
    ? (body["harnesses"] as Record<string, unknown>[])
    : [];
  return {
    ...body,
    available: harnesses.filter((item) => item["status"] === "ok").map((item) => item["id"]),
  };
}
