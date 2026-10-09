import { describe, expect, it } from "vitest";
import {
  ControlThreadCreateRequest,
  threadCreateWorkspaceViolation,
} from "./control-thread-requests.js";
import { ControlThreadTurnRequest } from "./control-operation-responses.js";
import { runExecutionWorkspaceRootAllowed } from "./run-strategy.js";
import { ThreadWorkspace, WorkspaceMode } from "./thread.js";

describe("delegated thread workspace contract", () => {
  it("adds the caller-owned mode without changing legacy request or record shapes", () => {
    expect(WorkspaceMode.options).toEqual(["in_place", "isolated", "delegated"]);
    // A pre-upgrade create body parses with NO injected key, so its durable
    // idempotency digest (hashed from the parsed request) is unchanged.
    const legacy = ControlThreadCreateRequest.parse({
      scope: { kind: "project", root: "/p" },
      workspace: "isolated",
    });
    expect("workspaceRoot" in legacy).toBe(false);
    // A legacy persisted workspace keeps its meaning with a null binding.
    expect(ThreadWorkspace.parse({ mode: "isolated", worktree_path: "/t" })).toMatchObject({
      mode: "isolated",
      worktree_path: "/t",
      workspace_root: null,
    });
    // Turns still cannot name or replace an execution root per turn.
    expect(() =>
      ControlThreadTurnRequest.parse({ prompt: "x", execution: { workspaceRoot: "/elsewhere" } }),
    ).toThrow();
    expect(() =>
      ControlThreadTurnRequest.parse({ prompt: "x", execution: { delegated: true } }),
    ).toThrow();
  });

  it.each([
    [{ workspace: "delegated", scope: { kind: "project" } }, /required/],
    [{ workspaceRoot: "/c", scope: { kind: "project" } }, /only with/],
    [{ workspace: "isolated", workspaceRoot: "/c", scope: { kind: "project" } }, /only with/],
    [{ workspace: "delegated", workspaceRoot: "/c", scope: { kind: "none" } }, /project scope/],
  ] as const)("refuses the incoherent binding %o", (request, message) => {
    expect(threadCreateWorkspaceViolation(request as never)).toMatch(message);
  });

  it("accepts exactly the coherent binding and every ordinary create", () => {
    expect(
      threadCreateWorkspaceViolation({
        workspace: "delegated",
        workspaceRoot: "/c",
        scope: { kind: "project" },
      }),
    ).toBeNull();
    expect(threadCreateWorkspaceViolation({ scope: { kind: "none" } })).toBeNull();
    expect(
      threadCreateWorkspaceViolation({ workspace: "in_place", scope: { kind: "project" } }),
    ).toBeNull();
  });

  it("admits an execution root only where it is a real delegated address", () => {
    const project = { kind: "project" };
    const allowed = (mode: string, execution: Record<string, unknown>, scope = project) =>
      runExecutionWorkspaceRootAllowed({ mode, scope, execution } as never);
    expect(allowed("agent", { delegated: true, isolation: "live" })).toBe(true);
    expect(
      allowed("agent", { delegated: true, isolation: "envelope", workspaceKind: "directory" }),
    ).toBe(true);
    expect(allowed("ask", { delegated: true, isolation: "envelope" })).toBe(true);
    expect(allowed("plan", { delegated: true })).toBe(true);
    // A Git envelope Agent would silently ignore it; no delegation, no address.
    expect(allowed("agent", { delegated: true, isolation: "envelope" })).toBe(false);
    expect(allowed("ask", { delegated: false })).toBe(false);
    expect(allowed("agent", { delegated: true, isolation: "live" }, { kind: "none" })).toBe(false);
  });
});
