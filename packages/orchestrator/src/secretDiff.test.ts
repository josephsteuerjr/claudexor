import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { WorkspaceError } from "@claudexor/core";
import type { HarnessEvent, WorkspaceEnvelope } from "@claudexor/schema";
import { projectRuntimeDir, sha256 } from "@claudexor/util";
import { readRevertAnchor, type WorkspaceManager } from "@claudexor/workspace";

import { PERSISTED_PATCH_NOTICE } from "./persistedPatch.js";
import {
  attemptDisclosure,
  captureCandidateWorkspace,
  CountedAnswerAssembly,
  persistFinalPatch,
  summaryDisclosure,
} from "./secretDiff.js";

const envelope = {
  id: "env-test",
  repo_root: "/tmp/project",
  worktree_path: "/tmp/project",
  base_sha: null,
} as WorkspaceEnvelope;

const roots: string[] = [];
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Fake credentials are assembled at runtime; no secret-shaped literal lives here. */
const fakeKey = (fill: string): string => ["sk", fill.repeat(24)].join("-");

function textPatch(path: string, line: string): string {
  return (
    `diff --git a/${path} b/${path}\n` +
    "new file mode 100644\n" +
    "--- /dev/null\n" +
    `+++ b/${path}\n` +
    "@@ -0,0 +1 @@\n" +
    `+${line}\n`
  );
}

function fakeManager(
  capture: () => Promise<{
    diff: string;
    binarySecretPaths: string[];
    captureIncomplete: boolean;
  }>,
  retained: string[] = [],
): WorkspaceManager {
  return {
    captureDiff: capture,
    ownedArtifactRelativeDirectory: () => null,
    retainEnvelope: (env: WorkspaceEnvelope) => retained.push(env.id),
  } as unknown as WorkspaceManager;
}

const capture = (
  wsm: WorkspaceManager,
  inPlace: boolean,
  extra: Partial<Parameters<typeof captureCandidateWorkspace>[0]> = {},
) =>
  captureCandidateWorkspace({
    wsm,
    envelope,
    inPlace,
    projectRoot: tempRoot("claudexor-v4c-project-"),
    answerMatches: 0,
    ...extra,
  });

describe("capture refusal is the only capture-time refusal (INV-062)", () => {
  it.each([
    { inPlace: true, disposition: "manual_cleanup" },
    { inPlace: false, disposition: "discarded" },
  ] as const)(
    "names a capture exception honestly for inPlace=$inPlace without echoing it",
    async ({ inPlace, disposition }) => {
      const wsm = fakeManager(async () => {
        throw new Error("sensitive capture sentinel");
      });

      const result = await capture(wsm, inPlace);

      expect(result.diff).toBe("");
      expect(result.captureRefusal?.disposition).toBe(disposition);
      expect(result.captureRefusal?.detail).not.toContain("sensitive capture sentinel");
      expect(result.captureRefusal?.detail).toMatch(
        inPlace ? /changed files are untouched/ : /discarded/,
      );
      expect(result.secretLike).toBeUndefined();
    },
  );

  it("requires manual cleanup when isolated capture scratch cleanup is unproven", async () => {
    const error = new WorkspaceError("transient diff scratch cleanup failed", {
      cause: new Error("sensitive cleanup error"),
    });
    Object.defineProperty(error, "cleanupError", {
      value: new Error("sensitive cleanup error"),
      enumerable: false,
    });
    const wsm = fakeManager(async () => {
      throw error;
    });

    const result = await capture(wsm, false);

    expect(result.captureRefusal).toMatchObject({ disposition: "manual_cleanup" });
    expect(result.captureRefusal?.detail).toMatch(/private scratch cleanup could not be proven/);
    expect(result.captureRefusal?.detail).not.toContain("sensitive");
  });

  it("turns an incomplete capture into a refusal instead of a fabricated empty result", async () => {
    const wsm = fakeManager(async () => ({
      diff: "",
      binarySecretPaths: [],
      captureIncomplete: true,
    }));

    const result = await capture(wsm, true);

    expect(result.diff).toBe("");
    expect(result.captureRefusal).toMatchObject({ disposition: "manual_cleanup" });
    expect(result.captureRefusal?.detail).toMatch(/could not be captured as a complete patch/);
  });
});

describe("secret-like content is kept and only hidden in saved copies (INV-062)", () => {
  it("keeps the exact in-place diff and never rolls anything back", async () => {
    const secret = fakeKey("r");
    const patch = textPatch("LEAK.txt", secret);
    // The repo path does not exist: any rollback attempt would have to fail loudly.
    const wsm = fakeManager(async () => ({
      diff: patch,
      binarySecretPaths: [],
      captureIncomplete: false,
    }));

    const result = await capture(wsm, true, { answerText: "done", answerMatches: 2 });

    expect(result.captureRefusal).toBeUndefined();
    expect(result.diff).toBe(patch);
    expect(result.persistedDiff?.startsWith(PERSISTED_PATCH_NOTICE)).toBe(true);
    expect(result.persistedDiff).not.toContain(secret);
    expect(result.persistedDiff).toContain("+[redacted]");
    expect(result.secretLike).toEqual({
      files: [{ path: "LEAK.txt", matches: 1, kinds: ["openai_compatible_api_key"] }],
      binary_paths: [],
      media_withheld: [],
      answer_matches: 2,
      total_matches: 3,
    });
    expect(JSON.stringify(result.secretLike)).not.toContain(secret);
  });

  it("leaves a clean candidate byte-exact with no notice and no disclosure", async () => {
    const patch = textPatch("SAFE.txt", "safe");
    const wsm = fakeManager(async () => ({
      diff: patch,
      binarySecretPaths: [],
      captureIncomplete: false,
    }));

    const result = await capture(wsm, false);

    expect(result).toEqual({ diff: patch });
  });

  it("withholds only the flagged binary payload in the saved copy and names its path", async () => {
    const patch =
      "diff --git a/assets/x.bin b/assets/x.bin\n" +
      "new file mode 100644\n" +
      "index 0000000..1111111\n" +
      "GIT binary patch\n" +
      "literal 12\n" +
      "TcmZQzU|?imU|`^5\n" +
      "\n" +
      "literal 0\n" +
      "HcmV?d00001\n" +
      "\n" +
      textPatch("SAFE.txt", "safe");
    const wsm = fakeManager(async () => ({
      diff: patch,
      binarySecretPaths: ["assets/x.bin"],
      captureIncomplete: false,
    }));

    const result = await capture(wsm, true);

    expect(result.diff).toBe(patch);
    expect(result.diff).toContain("TcmZQzU|?imU|`^5");
    expect(result.persistedDiff).toContain(
      "GIT binary patch\n# Claudexor: binary payload withheld",
    );
    expect(result.persistedDiff).not.toContain("TcmZQzU|?imU|`^5");
    expect(result.persistedDiff).toContain("+safe");
    expect(result.secretLike).toMatchObject({
      files: [],
      binary_paths: ["assets/x.bin"],
      total_matches: 0,
    });
  });

  it("discloses an unsaved oversized linked image without touching the candidate files", async () => {
    const repo = tempRoot("claudexor-secret-outside-patch-");
    writeFileSync(join(repo, "preview.png"), Buffer.alloc(16 * 1024 * 1024 + 1));
    writeFileSync(join(repo, "SAFE.txt"), "safe\n");
    const patch = textPatch("SAFE.txt", "safe");
    const wsm = fakeManager(async () => ({
      diff: patch,
      binarySecretPaths: [],
      captureIncomplete: false,
    }));

    const result = await captureCandidateWorkspace({
      wsm,
      envelope: { ...envelope, repo_root: repo, worktree_path: repo },
      inPlace: true,
      projectRoot: repo,
      answerText: "![preview](preview.png)",
      answerMatches: 0,
    });

    // Nothing is removed: the candidate's file and the image both stay in place.
    expect(readFileSync(join(repo, "SAFE.txt"), "utf8")).toBe("safe\n");
    expect(existsSync(join(repo, "preview.png"))).toBe(true);
    expect(result.captureRefusal).toBeUndefined();
    expect(result.diff).toBe(patch);
    expect(result.persistedDiff).toBeUndefined();
    expect(result.secretLike).toMatchObject({ media_withheld: ["preview.png"], total_matches: 0 });
  });

  it("discloses a symlinked image as unsaved and leaves the link and its target alone", async () => {
    const root = tempRoot("claudexor-secret-symlink-target-");
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    const target = join(outside, "leak.png");
    const link = join(repo, "preview.png");
    mkdirSync(repo, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(target, link);
    writeFileSync(link, Buffer.alloc(64));
    const patch =
      "diff --git a/preview.png b/preview.png\n" +
      "new file mode 120000\n" +
      "--- /dev/null\n" +
      "+++ b/preview.png\n" +
      "@@ -0,0 +1 @@\n" +
      `+${target}\n` +
      "\\ No newline at end of file\n";
    const wsm = fakeManager(async () => ({
      diff: patch,
      binarySecretPaths: [],
      captureIncomplete: false,
    }));

    const result = await captureCandidateWorkspace({
      wsm,
      envelope: { ...envelope, repo_root: repo, worktree_path: repo },
      inPlace: true,
      projectRoot: repo,
      answerText: "![preview](preview.png)",
      answerMatches: 0,
    });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(result.captureRefusal).toBeUndefined();
    expect(result.diff).toBe(patch);
    expect(result.secretLike?.media_withheld).toEqual(["preview.png"]);
  });
});

describe("exact bytes of an isolated candidate survive its envelope (INV-062)", () => {
  it("writes the private exact patch object while the envelope still exists", async () => {
    const projectRoot = tempRoot("claudexor-v4c-exact-");
    const patch = textPatch("LEAK.txt", fakeKey("e"));
    const retained: string[] = [];
    const wsm = fakeManager(
      async () => ({ diff: patch, binarySecretPaths: [], captureIncomplete: false }),
      retained,
    );

    const result = await capture(wsm, false, { projectRoot });

    expect(result.persistedDiff).toBeDefined();
    expect(readRevertAnchor(projectRoot, sha256(patch))).toBe(patch);
    expect(retained).toEqual([]);
  });

  it("keeps the envelope when the exact object cannot be written", async () => {
    const projectRoot = tempRoot("claudexor-v4c-exact-fail-");
    // A regular file where the object store directory must be makes the write fail.
    mkdirSync(projectRuntimeDir(projectRoot), { recursive: true });
    writeFileSync(join(projectRuntimeDir(projectRoot), "anchors"), "not a directory");
    roots.push(projectRuntimeDir(projectRoot));
    const patch = textPatch("LEAK.txt", fakeKey("f"));
    const retained: string[] = [];
    const wsm = fakeManager(
      async () => ({ diff: patch, binarySecretPaths: [], captureIncomplete: false }),
      retained,
    );

    const result = await capture(wsm, false, { projectRoot });

    // The candidate is still a working candidate with its exact diff and saved copy...
    expect(result.captureRefusal).toBeUndefined();
    expect(result.diff).toBe(patch);
    expect(result.persistedDiff).not.toContain(fakeKey("f"));
    // ...and the only other holder of the exact bytes is not deleted.
    expect(retained).toEqual(["env-test"]);
    // The diagnostic says where those bytes still are.
    expect(result.exactBytesRetainedAt).toBe(envelope.worktree_path);
    expect(attemptDisclosure(result)).toMatchObject({
      exact_bytes_retained_at: envelope.worktree_path,
      secret_like: { total_matches: 1 },
    });
  });

  it("does not write an exact object for an in-place candidate at capture time", async () => {
    const projectRoot = tempRoot("claudexor-v4c-inplace-");
    const patch = textPatch("LEAK.txt", fakeKey("i"));
    const wsm = fakeManager(async () => ({
      diff: patch,
      binarySecretPaths: [],
      captureIncomplete: false,
    }));

    await capture(wsm, true, { projectRoot });

    expect(() => readRevertAnchor(projectRoot, sha256(patch))).toThrow();
  });
});

describe("persistFinalPatch", () => {
  function storeFor(prefix: string) {
    const repo = tempRoot(prefix);
    const store = new ArtifactStore(repo, { claudexorDir: join(repo, "runtime") });
    roots.push(projectRuntimeDir(repo));
    return { repo, store, paths: store.createRun("run-v4c") };
  }

  it("saves the redacted copy, binds the digest to the exact patch and stores the exact object", () => {
    const { repo, store, paths } = storeFor("claudexor-v4c-final-");
    const secret = fakeKey("p");
    const diff = textPatch("LEAK.txt", secret);

    const saved = persistFinalPatch(store, paths.finalDir, { diff });

    const copy = readFileSync(join(paths.finalDir, "patch.diff"), "utf8");
    expect(copy.startsWith(PERSISTED_PATCH_NOTICE)).toBe(true);
    expect(copy).not.toContain(secret);
    // The digest is of the EXACT patch, so the copy can never pass the apply gate.
    expect(saved.patchSha256).toBe(sha256(diff));
    expect(sha256(copy)).not.toBe(saved.patchSha256);
    expect(saved.meta).toEqual({
      persisted_patch: "redacted",
      exact_patch_object: saved.patchSha256,
    });
    expect(readRevertAnchor(repo, saved.patchSha256)).toBe(diff);
  });

  it("leaves a clean patch byte-exact with no extra meta", () => {
    const { repo, store, paths } = storeFor("claudexor-v4c-final-clean-");
    const diff = textPatch("SAFE.txt", "safe");

    const saved = persistFinalPatch(store, paths.finalDir, { diff });

    expect(readFileSync(join(paths.finalDir, "patch.diff"), "utf8")).toBe(diff);
    expect(saved).toEqual({ patchSha256: sha256(diff), meta: {} });
    expect(() => readRevertAnchor(repo, saved.patchSha256)).toThrow();
  });

  it("records a null exact object when it cannot be stored; the copy is still saved", () => {
    const { repo, store, paths } = storeFor("claudexor-v4c-final-nostore-");
    mkdirSync(projectRuntimeDir(repo), { recursive: true });
    writeFileSync(join(projectRuntimeDir(repo), "anchors"), "not a directory");
    const diff = textPatch("LEAK.txt", fakeKey("n"));

    const saved = persistFinalPatch(store, paths.finalDir, { diff });

    expect(saved.meta).toEqual({ persisted_patch: "redacted", exact_patch_object: null });
    expect(readFileSync(join(paths.finalDir, "patch.diff"), "utf8")).not.toContain(fakeKey("n"));
    // With a kept envelope the record points at the surviving exact bytes.
    expect(
      persistFinalPatch(store, paths.finalDir, { diff, exactBytesRetainedAt: "/kept/tree" }).meta,
    ).toEqual({
      persisted_patch: "redacted",
      exact_patch_object: null,
      exact_bytes_retained_at: "/kept/tree",
    });
  });
});

describe("answer match counting happens before the first redaction", () => {
  const message = (text: string, extra: Partial<HarnessEvent> = {}): HarnessEvent =>
    ({ type: "message", session_id: "s", ts: "t", text, ...extra }) as HarnessEvent;
  const redactedTwin = (raw: HarnessEvent, secret: string): HarnessEvent =>
    ({ ...raw, text: raw.text?.split(secret).join("[redacted]") }) as HarnessEvent;

  it("counts on the raw event while the assembly only ever sees the redacted one", () => {
    const secret = fakeKey("a");
    const answer = new CountedAnswerAssembly();
    const raw = message(`first ${secret} then ${secret}`);

    answer.observeCounted(raw, redactedTwin(raw, secret));

    expect(answer.text()).toBe("first [redacted] then [redacted]");
    expect(answer.text()).not.toContain(secret);
    expect(answer.secretLikeMatches()).toBe(2);
  });

  it("lets a typed final replace the narration count and ignores streamed deltas", () => {
    const secret = fakeKey("b");
    const answer = new CountedAnswerAssembly();
    const narration = message(`thinking about ${secret}`);
    const delta = message(`del ${secret}`, { payload: { delta: true } });
    const final = message(`final answer mentions ${secret} once`, { final: true });

    answer.observeCounted(narration, redactedTwin(narration, secret));
    answer.observeCounted(delta, redactedTwin(delta, secret));
    expect(answer.secretLikeMatches()).toBe(1);
    answer.observeCounted(final, redactedTwin(final, secret));

    expect(answer.secretLikeMatches()).toBe(1);
    expect(answer.text()).toBe("final answer mentions [redacted] once");
  });
});

describe("summary disclosure line", () => {
  it("names files and counts, never a value, and is empty for a clean run", () => {
    expect(summaryDisclosure(undefined)).toBe("");
    const line = summaryDisclosure({
      files: [
        { path: "a.txt", matches: 2, kinds: ["jwt"] },
        { path: "b.txt", matches: 1, kinds: ["github_token"] },
      ],
      binary_paths: ["x.bin"],
      media_withheld: ["shot.png"],
      answer_matches: 1,
      total_matches: 4,
    });
    expect(line).toBe(
      "\n- Secret-like strings: 3 in 2 changed file(s) (a.txt, b.txt) — kept in the changed files, hidden in saved copies; " +
        "1 binary payload(s) withheld from the saved patch (x.bin); 1 hidden in the answer; 1 image(s) not saved (shot.png)",
    );
  });
});
