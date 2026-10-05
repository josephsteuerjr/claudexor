import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envelopeBaseOf, readEnvelopeCustody } from "./envelope-custody.js";
import { WorkspaceManager } from "./manager.js";
import {
  RETAINED_ENVELOPE_POINTER,
  adoptRetainedEnvelope,
  recoverOrphanCustody,
  releaseRetainedEnvelope,
  retainForContinuation,
  retainedEnvelopeOfRun,
} from "./retained-envelopes.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-retained-${name}-`)));
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

/** Route-scoped auth material the adapters place in a scoped home. */
function seedAuth(home: string): { codexAuth: string; bridge: string } {
  const codexAuth = join(home, ".codex", "auth.json");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(codexAuth, "{}\n");
  const bridge = join(home, ".claudexor-claude-native", "Library", "Keychains");
  mkdirSync(join(home, ".claudexor-claude-native", "Library"), { recursive: true });
  symlinkSync(tmpdir(), bridge, "dir");
  return { codexAuth, bridge };
}

function linkExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function createKept(repo: string, runDir: string, taskId = "task-p") {
  const wsm = new WorkspaceManager(repo);
  const env = await wsm.create({
    taskId,
    attemptId: "a01",
    baseRef: "HEAD",
    dirtyPolicy: "snapshot",
    custody: { runId: "run-p", runDir },
  });
  writeFileSync(join(env.worktree_path, "a.txt"), "edited\n");
  writeFileSync(join(env.worktree_path, "new.txt"), "new file\n");
  return { wsm, env };
}

describe("retained envelopes (A9 custody)", () => {
  it("survives dispose, strips route-scoped auth, and is adopted with identical files", async () => {
    const repo = initRepo();
    const predRunDir = temp("pred-run");
    const succRunDir = temp("succ-run");
    const { wsm, env } = await createKept(repo, predRunDir);
    const base = envelopeBaseOf(env);
    expect(readEnvelopeCustody(base)).toMatchObject({ state: "live", holder_run_id: "run-p" });
    const auth = seedAuth(env.home_dir);

    const custody = retainForContinuation(env, { runId: "run-p", runDir: predRunDir }, "cancelled");
    expect(custody).toMatchObject({ state: "retained", cause: "cancelled" });
    expect(custody.bytes).toBeGreaterThan(0);
    expect(existsSync(auth.codexAuth)).toBe(false);
    expect(linkExists(auth.bridge)).toBe(false);
    expect(retainedEnvelopeOfRun(predRunDir, "run-p")?.envelope.id).toBe(env.id);
    expect(retainedEnvelopeOfRun(predRunDir, "run-other")).toBeNull();

    // Durable custody, not per-instance memory: no manager disposes it.
    await wsm.dispose(env);
    await new WorkspaceManager(repo).dispose(env);
    expect(existsSync(env.worktree_path)).toBe(true);

    const adopted = adoptRetainedEnvelope(custody, { runId: "run-s", runDir: succRunDir });
    expect(adopted).toEqual(env);
    expect(readFileSync(join(adopted.worktree_path, "a.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(adopted.worktree_path, "new.txt"), "utf8")).toBe("new file\n");
    expect(readEnvelopeCustody(base)).toMatchObject({ state: "live", holder_run_id: "run-s" });
    expect(JSON.parse(readFileSync(join(base, "owner.json"), "utf8"))).toMatchObject({
      pid: process.pid,
      envelope_id: env.id,
    });
    // The predecessor no longer reports the envelope; its pointer is gone.
    expect(existsSync(join(predRunDir, RETAINED_ENVELOPE_POINTER))).toBe(false);
    expect(retainedEnvelopeOfRun(predRunDir, "run-p")).toBeNull();

    // A live (adopted) envelope that finishes is disposed as before.
    await wsm.dispose(adopted);
    expect(existsSync(base)).toBe(false);
  });

  it("releases a kept envelope and its run pointer on disposition", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    const { env } = await createKept(repo, runDir);
    const custody = retainForContinuation(env, { runId: "run-p", runDir }, null);
    await releaseRetainedEnvelope(custody);
    expect(existsSync(envelopeBaseOf(env))).toBe(false);
    expect(existsSync(join(runDir, RETAINED_ENVELOPE_POINTER))).toBe(false);
  });

  it("recovers custody of ownerless envelopes after a crash", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    // Crashed mid-attempt with edits: kept as retained (host_restart).
    const { env: crashed } = await createKept(repo, runDir, "task-crash");
    expect(await recoverOrphanCustody(envelopeBaseOf(crashed))).toBe("retained");
    expect(readEnvelopeCustody(envelopeBaseOf(crashed))).toMatchObject({
      state: "retained",
      cause: "host_restart",
    });
    expect(retainedEnvelopeOfRun(runDir, "run-p")?.envelope.id).toBe(crashed.id);
    // Already retained: kept, its auth stripped again.
    const auth = seedAuth(crashed.home_dir);
    expect(await recoverOrphanCustody(envelopeBaseOf(crashed))).toBe("kept");
    expect(existsSync(auth.codexAuth)).toBe(false);
    // Crashed before any change: nothing to continue, an ordinary orphan.
    const clean = await new WorkspaceManager(repo).create({
      taskId: "task-clean",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: { runId: "run-c", runDir },
    });
    expect(await recoverOrphanCustody(envelopeBaseOf(clean))).toBeNull();
    // No custody at all: an ordinary orphan.
    const plain = await new WorkspaceManager(repo).create({
      taskId: "task-plain",
      attemptId: "a01",
    });
    writeFileSync(join(plain.worktree_path, "a.txt"), "edited\n");
    expect(await recoverOrphanCustody(envelopeBaseOf(plain))).toBeNull();
  });
});
