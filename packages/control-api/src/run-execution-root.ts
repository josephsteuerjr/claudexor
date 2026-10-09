/**
 * Where a run's files live, kept apart from the stable project it is
 * identified by (INV-072/INV-073). A delegated run records its caller-owned
 * `execution.workspaceRoot`; every reader of that run's files resolves there
 * and never substitutes the project's same-named files.
 */
import type { DaemonRunRecord } from "./daemon-server.js";

/** The caller-owned execution address a delegated run recorded in its params. */
export function runExecutionWorkspaceRoot(rec: DaemonRunRecord): string | null {
  const execution = (rec.params as { execution?: { workspaceRoot?: unknown } } | undefined)
    ?.execution;
  const root = execution?.workspaceRoot;
  return typeof root === "string" && root.trim() ? root : null;
}

/** The tree a run's file references resolve in: its recorded caller-owned
 *  workspace, otherwise its project root; null without a project. */
export function runExecutionRoot(rec: DaemonRunRecord, projectRoot: string | null): string | null {
  return projectRoot === null ? null : (runExecutionWorkspaceRoot(rec) ?? projectRoot);
}

/** A run's stable project identity (null without project scope) and optional
 *  caller-owned workspace override. Run identity remains bound without an override. */
export interface RunWorkspaceBinding {
  projectRoot: string | null;
  workspaceRoot: string | null;
}

/** Every run-addressed project file read verifies the run's project identity,
 *  including ordinary runs whose files live in their project. */
export function runWorkspaceBinding(rec: DaemonRunRecord): RunWorkspaceBinding {
  const workspaceRoot = runExecutionWorkspaceRoot(rec);
  const scope = (rec.params as { scope?: { kind?: unknown; root?: unknown } } | undefined)?.scope;
  const projectRoot =
    scope?.kind === "project" && typeof scope.root === "string" && scope.root.trim()
      ? scope.root
      : null;
  return { projectRoot, workspaceRoot };
}
