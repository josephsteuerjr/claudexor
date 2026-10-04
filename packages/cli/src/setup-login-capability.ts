import { nativeLoginUnavailableDetail } from "./native-login.js";
import { interpretedCommand } from "@claudexor/core";
import type { HarnessAdapter } from "@claudexor/core";
import type {
  ControlSetupJobTransport,
  SetupLoginCapability,
  SetupTerminalTransportErrorCode,
} from "@claudexor/schema";
import { buildRegistry } from "./registry.js";
import { nativeLoginSpec, type CodexLoginFlow, type NativeLoginSpec } from "./native-login.js";
import {
  resolvePtyWrappedCommand,
  type TerminalTransportBackend,
  type TerminalTransportResolution,
} from "./setup-login-pty.js";

export type SetupLoginCapabilityStatus =
  | "ready"
  | "manifest_unsupported"
  | "vendor_binary_unavailable"
  | "terminal_transport_unavailable"
  | "terminal_transport_unsupported"
  | "terminal_transport_probe_failed";

export interface SetupLoginCapabilityProjection {
  status: SetupLoginCapabilityStatus;
  backend: "direct" | TerminalTransportBackend | null;
  capability: SetupLoginCapability | null;
  detail: string;
  errorCode?: Exclude<SetupTerminalTransportErrorCode, "terminal_transport_failed">;
}

type ResolveTerminalTransport = (
  childBinary: string,
  childArgs: readonly string[],
) => Promise<TerminalTransportResolution>;

export interface SetupLoginCapabilityOptions {
  transport?: ControlSetupJobTransport;
  loginFlow?: CodexLoginFlow;
  getAdapter?: (harness: string) => HarnessAdapter | undefined;
  resolveLoginSpec?: (harness: string, loginFlow?: CodexLoginFlow) => NativeLoginSpec | null;
  resolveTerminalTransport?: ResolveTerminalTransport;
}

const EXTERNAL_TERMINAL: SetupLoginCapability = { mode: "external_terminal" };
const IN_APP: SetupLoginCapability = { mode: "in_app" };

/**
 * One effective setup-login projector for status, catalog, and create
 * admission. Static manifest input is consulted without vendor discovery;
 * exact vendor binary readiness comes from nativeLoginSpec; terminal stdin
 * alone reaches the shared bounded PTY/ConPTY resolver.
 */
export async function projectSetupLoginCapability(
  harness: string,
  options: SetupLoginCapabilityOptions = {},
): Promise<SetupLoginCapabilityProjection> {
  const getAdapter =
    options.getAdapter ?? ((id: string) => buildRegistry({ includeFakes: false }).get(id));
  const declaration = getAdapter(harness)?.capabilityProfile?.auth.managed_login;
  if (!declaration) {
    return {
      status: "manifest_unsupported",
      backend: null,
      capability: null,
      detail: "the harness declares no managed subscription login",
    };
  }

  const resolveLogin =
    options.resolveLoginSpec ??
    ((id: string, flow?: CodexLoginFlow) => nativeLoginSpec(id, undefined, flow));
  const spec = resolveLogin(harness, options.loginFlow);
  if (!spec) {
    return {
      status: "vendor_binary_unavailable",
      backend: null,
      capability: null,
      detail:
        nativeLoginUnavailableDetail(harness) ??
        "the managed vendor login command is unavailable on this host",
    };
  }

  // client_pty is the explicit external-terminal fallback. It still requires
  // an exact vendor command, but never asks the daemon to prove a PTY backend.
  if (options.transport === "client_pty") {
    return {
      status: "ready",
      backend: null,
      capability: EXTERNAL_TERMINAL,
      detail: "the exact vendor login command is ready for external-terminal attachment",
    };
  }

  if (declaration.stdin !== "terminal") {
    return {
      status: "ready",
      backend: "direct",
      capability: IN_APP,
      detail: "the exact vendor login command is ready for daemon-hosted input",
    };
  }

  const invocation = interpretedCommand(spec.binary, spec.args, {}, spec.interpreter);
  const resolution = await (options.resolveTerminalTransport ?? resolvePtyWrappedCommand)(
    invocation.binary,
    invocation.args,
  );
  if (resolution.status === "ready") {
    return {
      status: "ready",
      backend: resolution.backend,
      capability: IN_APP,
      detail: "the daemon terminal transport passed its bounded capability probe",
    };
  }
  return {
    status: `terminal_transport_${resolution.status}`,
    backend: resolution.backend,
    capability: EXTERNAL_TERMINAL,
    detail: resolution.detail,
    errorCode: resolution.errorCode,
  };
}

/** Thin public wire: current producers always emit this null/object value. */
export async function effectiveSetupLoginCapability(
  harness: string,
  options: Omit<SetupLoginCapabilityOptions, "transport"> = {},
): Promise<SetupLoginCapability | null> {
  return (await projectSetupLoginCapability(harness, { ...options, transport: "daemon" }))
    .capability;
}

/**
 * Map only pre-job daemon terminal failures into the frozen request-problem
 * contract. Manifest/vendor misses remain the manager's existing durable
 * not-supported result; client_pty projections are ready and never enter here.
 */
export function assertSetupLoginAdmission(projection: SetupLoginCapabilityProjection): void {
  if (!projection.errorCode) return;
  const probeFailed = projection.errorCode === "terminal_transport_probe_failed";
  const fieldMessage = probeFailed
    ? "Daemon-hosted terminal transport could not be verified; retry setup login or use the external terminal flow."
    : "Daemon-hosted terminal transport is unavailable; use the external terminal flow.";
  throw Object.assign(new Error(projection.detail), {
    status: probeFailed ? 503 : 409,
    code: projection.errorCode,
    retryable: probeFailed,
    fieldErrors: { "/transport": [fieldMessage] },
    requiredActions: probeFailed
      ? ["retry_setup_login", "use_external_terminal"]
      : ["use_external_terminal"],
  });
}
