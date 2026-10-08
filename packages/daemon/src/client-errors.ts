/** Only failures of the local RPC transport carry this retryable 503 type.
 * A lost answer does not establish whether a mutation was accepted. */
export class DaemonTransportError extends Error {
  readonly status = 503;
  readonly retryable = true;
  readonly code: "daemon_busy" | "daemon_unavailable";

  constructor(method: string, reason: "timeout" | "unavailable", cause?: unknown) {
    super(
      reason === "timeout"
        ? `daemon RPC timeout (${method})`
        : `daemon RPC unavailable (${method})`,
      { cause },
    );
    this.name = "DaemonTransportError";
    this.code = reason === "timeout" ? "daemon_busy" : "daemon_unavailable";
  }
}
