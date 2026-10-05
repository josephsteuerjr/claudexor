import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commandScopeRoots } from "@claudexor/daemon";
import {
  WorkspaceManager,
  adoptRetainedEnvelope,
  envelopeBaseOf,
  readEnvelopeCustody,
  retainForContinuation,
  retainedEnvelopeOfRun,
} from "@claudexor/workspace";
import { sweepOrphanWorkspaces } from "./orphan-sweeper.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-sweep-custody-${name}-`)));
  dirs.push(dir);
  return dir;
}

function initRepo(): string {
  const dir = temp("repo");
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
  return dir;
}

/** The previous daemon process is gone: its owner marker names a dead pid. */
function ownerDied(base: string): void {
  writeFileSync(
    join(base, "owner.json"),
    JSON.stringify({ pid: 999_999_990, started: "Thu Jan  1 00:00:00 1970" }) + "\n",
  );
}

async function editedEnvelope(repo: string, runDir: string, taskId: string) {
  const env = await new WorkspaceManager(repo).create({
    taskId,
    attemptId: "a01",
    baseRef: "HEAD",
    custody: { runId: `run-${taskId}`, runDir },
  });
  writeFileSync(join(env.worktree_path, "a.txt"), "edited\n");
  writeFileSync(join(env.worktree_path, "new.txt"), "new file\n");
  return env;
}

describe("crash GC honors continuation custody", () => {
  it("keeps a retained envelope across a daemon restart; a successor adopts the same files", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    const env = await editedEnvelope(repo, runDir, "task-kept");
    retainForContinuation(env, { runId: "run-task-kept", runDir }, "pool_exhausted");
    ownerDied(envelopeBaseOf(env));

    const knownProjectRoots = () =>
      commandScopeRoots([{ params: { scope: { kind: "project", root: repo } } }]);
    const actions = await sweepOrphanWorkspaces({ knownProjectRoots });

    expect(actions.some((a) => a.startsWith("kept retained envelope task-kept/a01"))).toBe(true);
    const custody = retainedEnvelopeOfRun(runDir, "run-task-kept");
    expect(custody?.envelope.id).toBe(env.id);
    const adopted = adoptRetainedEnvelope(custody!, { runId: "run-next", runDir: temp("next") });
    expect(readFileSync(join(adopted.worktree_path, "a.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(adopted.worktree_path, "new.txt"), "utf8")).toBe("new file\n");
  });

  it("keeps the edits of a run interrupted mid-attempt and sweeps an untouched one", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    const edited = await editedEnvelope(repo, runDir, "task-crash");
    const untouched = await new WorkspaceManager(repo).create({
      taskId: "task-idle",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: { runId: "run-task-idle", runDir: temp("idle-run") },
    });
    ownerDied(envelopeBaseOf(edited));
    ownerDied(envelopeBaseOf(untouched));

    const actions = await sweepOrphanWorkspaces({
      knownProjectRoots: () =>
        commandScopeRoots([{ params: { scope: { kind: "project", root: repo } } }]),
    });

    expect(actions.some((a) => a.startsWith("retained interrupted envelope task-crash/a01"))).toBe(
      true,
    );
    expect(readEnvelopeCustody(envelopeBaseOf(edited))).toMatchObject({
      state: "retained",
      cause: "host_restart",
      holder_run_id: "run-task-crash",
    });
    expect(retainedEnvelopeOfRun(runDir, "run-task-crash")?.envelope.id).toBe(edited.id);
    expect(existsSync(envelopeBaseOf(untouched))).toBe(false);
  });
});
