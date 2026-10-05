import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceManager,
  envelopeBaseOf,
  retainForContinuation,
  retainedEnvelopeOfRun,
} from "@claudexor/workspace";
import { afterAll, describe, expect, it } from "vitest";
import { discardRunResult } from "./run-discard.js";
import type { DaemonRunRecord } from "./run-record.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-discard-${name}-`)));
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

describe("discard decision", () => {
  it("releases a kept stopped run's envelope and records the disposition", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    mkdirSync(join(runDir, "final"), { recursive: true });
    writeFileSync(join(runDir, "events.jsonl"), "");
    const env = await new WorkspaceManager(repo).create({
      taskId: "task-d",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: { runId: "run-d", runDir },
    });
    writeFileSync(join(env.worktree_path, "a.txt"), "edited\n");
    retainForContinuation(env, { runId: "run-d", runDir }, "cancelled");
    const rec: DaemonRunRecord = { id: "job-d", runId: "run-d", state: "cancelled", runDir };

    await expect(discardRunResult(rec)).resolves.toMatchObject({
      accepted: true,
      status: "discarded",
    });
    expect(existsSync(envelopeBaseOf(env))).toBe(false);
    expect(retainedEnvelopeOfRun(runDir, "run-d")).toBeNull();
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain('"decision":"discard"');
  });

  it("refuses a run that holds nothing to discard", async () => {
    const runDir = temp("run");
    const rec: DaemonRunRecord = { id: "job-x", runId: "run-x", state: "failed", runDir };
    await expect(discardRunResult(rec)).rejects.toMatchObject({ status: 409 });
  });
});
