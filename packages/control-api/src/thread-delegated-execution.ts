/** Server-owned execution projection of a delegated thread's turns. */

/**
 * The server-owned execution projection of a delegated thread turn: the
 * caller-owned root bound at creation plus the delegated authority marker.
 * Agent Git turns run live there; a per-turn request for an envelope would
 * contradict the immutable binding and is refused instead of silently
 * redirected. Ordinary threads get no projection (their runner resolves it).
 */
export function delegatedThreadExecution(
  workspace: { mode?: string; workspace_root?: string | null } | undefined,
  mode: string,
  execution: { workspaceKind?: string; isolation?: string } | undefined,
): { delegated: true; workspaceRoot: string } | Record<string, never> {
  if (workspace?.mode !== "delegated") return {};
  const root = workspace.workspace_root;
  if (typeof root !== "string" || !root) {
    throw Object.assign(new Error("delegated thread has no recorded workspace root"), {
      status: 409,
      code: "thread_workspace_binding_missing",
      retryable: false,
    });
  }
  if (
    mode === "agent" &&
    execution?.workspaceKind !== "directory" &&
    execution?.isolation === "envelope"
  ) {
    throw Object.assign(
      new Error(
        "a delegated thread's Agent turns execute live in its bound workspace; execution.isolation='envelope' contradicts that binding",
      ),
      { status: 400, code: "thread_execution_conflict", retryable: false },
    );
  }
  return { delegated: true, workspaceRoot: root };
}
