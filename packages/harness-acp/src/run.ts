import * as acp from "@agentclientprotocol/sdk";
import {
  abortSignalFromSpec,
  HarnessUnavailableError,
  promptWithInstructions,
} from "@claudexor/core";
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { CLAUDEXOR_VERSION, redactSecrets } from "@claudexor/util";
import { Channel } from "./channel.js";
import type { AcpEntry } from "./entry.js";
import { acpToken, prepareAcpEnv } from "./env.js";
import { AcpEvents, AcpFailure } from "./events.js";
import { acpArgs } from "./policy.js";
import { connectAcp, type AcpObservation } from "./transport.js";

export const ACP_DISCLOSURE =
  "ACP preview: readonly uses a CLI tool allowlist; workspace writes and shell commands are not sandboxed. Permission callbacks may be absent (github/copilot-cli#4537); write containment is unproven. Network is uncontrolled; cost may be unknown; live input and MCP injection are unavailable.";

export interface AcpRunOptions {
  probe?: boolean;
  observation?: AcpObservation;
}

export function acpRunner(entry: AcpEntry) {
  const active = new Map<string, () => Promise<void>>();
  return {
    async cancel(sessionId: string) {
      await active.get(sessionId)?.();
    },
    async *run(spec: HarnessRunSpec, options: AcpRunOptions = {}): AsyncGenerator<HarnessEvent> {
      const events = new AcpEvents(spec.session_id, entry.disabledToolsNotice);
      const queue = new Channel<HarnessEvent>();
      const abort = new AbortController();
      const observation = options.observation ?? {
        writePermission: false,
        promptDispatched: false,
      };
      let transport: ReturnType<typeof connectAcp> | undefined;
      let prepared: ReturnType<typeof prepareAcpEnv> | undefined;
      let cancelled = false;
      let failure: unknown;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const emit = (event: HarnessEvent) => queue.push(event, abort.signal);
      const external = abortSignalFromSpec(spec);
      const cancel = async () => {
        cancelled = true;
        if (transport) await transport.cancel();
        else abort.abort();
      };
      const onAbort = () => {
        void cancel().catch((error: unknown) => {
          failure = error;
        });
      };
      if (active.has(spec.session_id))
        throw new HarnessUnavailableError("ACP session is already active");
      // Typed pre-spawn refusals throw like the check above, so the engine keeps
      // their failure class instead of a generic acp_error event.
      const args = acpArgs(entry, spec);
      const token = acpToken(entry, spec.credential_profile);
      active.set(spec.session_id, cancel);
      external?.addEventListener("abort", onAbort, { once: true });
      const work = (async () => {
        try {
          if (external?.aborted) {
            cancelled = true;
            return;
          }
          if (spec.resume_session_id)
            throw new AcpFailure(
              "resume_unsupported",
              "ACP session/load is not supported in stage 1",
            );
          if (spec.auth_preference === "subscription")
            throw new AcpFailure("auth_profile_incompatible", "ACP requires a managed API token");
          if (spec.external_context_policy === "off" || spec.tool_permission_policy.web === "off")
            throw new AcpFailure("web_policy_incompatible", "ACP cannot enforce web policy off");
          if (spec.extra_mcp_servers.length)
            throw new AcpFailure(
              "mcp_unsupported",
              "ACP MCP injection is not supported in stage 1",
            );
          prepared = prepareAcpEnv(entry, token, spec.env);
          await emit(
            events.event("started", {
              credential_route: "managed_api_key",
              credential_source: "api_key_env",
              ...(spec.credential_profile
                ? { credential_profile_id: spec.credential_profile.profile_id }
                : {}),
            }),
          );
          await emit(events.event("status", { text: ACP_DISCLOSURE }));
          transport = connectAcp({
            binary: process.env[entry.binaryEnv] ?? entry.binary,
            args,
            env: prepared.env,
            spec,
            abort,
            events,
            observation,
            emit,
          });
          timer = setTimeout(() => {
            failure = new AcpFailure("startup_timeout", "ACP initialize/session/new timed out");
            void transport?.close().catch((error: unknown) => {
              failure = error;
            });
          }, 15_000);
          const agent = transport.connection.agent;
          const initialized = await agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "claudexor", version: CLAUDEXOR_VERSION },
          });
          if (initialized.protocolVersion !== acp.PROTOCOL_VERSION)
            throw new AcpFailure("protocol_version", "ACP v1 negotiation failed");
          observation.version = initialized.agentInfo?.version;
          observation.session = await agent.request(acp.methods.agent.session.new, {
            cwd: spec.cwd,
            mcpServers: [],
          });
          clearTimeout(timer);
          timer = undefined;
          if (options.probe) return;
          observation.promptDispatched = true;
          const result = await agent.request(acp.methods.agent.session.prompt, {
            sessionId: observation.session.sessionId,
            prompt: [{ type: "text", text: promptWithInstructions(spec) }],
          });
          cancelled ||= result.stopReason === "cancelled";
          for (const event of events.finish(result.stopReason)) await emit(event);
        } catch (error) {
          failure ??= error;
        } finally {
          if (timer) clearTimeout(timer);
          try {
            await transport?.close();
          } catch (error) {
            failure = error;
          }
          try {
            prepared?.dispose();
          } catch (error) {
            failure ??= error;
          }
          external?.removeEventListener("abort", onAbort);
          active.delete(spec.session_id);
          if (!queue.closed) {
            if (
              failure &&
              (!cancelled ||
                (failure instanceof AcpFailure && failure.code === "termination_unconfirmed"))
            ) {
              const auth = failure instanceof acp.RequestError && failure.code === -32000;
              const code = auth
                ? "not_logged_in"
                : failure instanceof AcpFailure
                  ? failure.code
                  : "acp_error";
              const message = auth
                ? "ACP agent requires authentication (not logged in)"
                : failure instanceof Error
                  ? failure.message
                  : String(failure);
              await queue.push(
                events.event("error", {
                  text: message,
                  error: message,
                  payload: {
                    code,
                    retryable: false,
                    prompt_delivery: observation.promptDispatched
                      ? "possibly_delivered"
                      : "not_sent",
                  },
                }),
              );
            }
            await queue.push(events.event("completed", { payload: { aborted: cancelled } }));
            queue.close();
          }
        }
      })();
      try {
        for await (const event of queue.read()) {
          // Redact before storage, including unknown wire fields and error diagnostics.
          const json = JSON.stringify(event, (_key, value: unknown) =>
            typeof value === "string"
              ? redactSecrets(token ? value.split(token).join("[REDACTED]") : value)
              : value,
          );
          yield JSON.parse(json) as HarnessEvent;
        }
      } finally {
        queue.close();
        try {
          await cancel();
        } finally {
          await work;
        }
      }
    },
  };
}
