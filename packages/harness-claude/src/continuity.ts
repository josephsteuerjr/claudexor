/**
 * Claude Code session continuity (locate / move / typed rejection).
 *
 * A Claude session is one transcript `<store>/projects/<enc(cwd)>/<sid>.jsonl`
 * plus the sibling `<sid>/` directory (spilled `tool-results/`, `subagents/`).
 * The store is the Claudexor-owned `CLAUDE_CONFIG_DIR`: a registered profile's
 * `isolation_locator` (named by the engine under the neutral
 * `CLAUDEXOR_PROFILE_LOCATOR` key) or the default native store. Transcripts
 * carry no account binding, so a move is a verified copy into the target
 * account's store at the project dir of the cwd the child will use, then the
 * retirement of the source — never `.claude.json`, never credentials.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  CONTINUITY_PROFILE_LOCATOR_ENV,
  type EnvMap,
  type HarnessContinuityCapability,
} from "@claudexor/core";
import { claudeNativeEnv } from "./index.js";
import { canonicalProfileConfigDir } from "./profile.js";

/** Claude Code's project-dir encoding of a working directory (every non-alphanumeric → `-`). */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** The store the engine named (profile locator) or the default native store. */
export function claudeStoreDir(env: EnvMap): string {
  const locator = env[CONTINUITY_PROFILE_LOCATOR_ENV];
  if (typeof locator === "string" && locator.trim()) return canonicalProfileConfigDir(locator);
  return String(claudeNativeEnv(env).CLAUDE_CONFIG_DIR);
}

function transcriptCandidates(store: string, sid: string, cwd: string): string[] {
  const projects = join(store, "projects");
  const out: string[] = [];
  const preferred = join(projects, claudeProjectDirName(cwd), `${sid}.jsonl`);
  if (existsSync(preferred)) out.push(preferred);
  if (!existsSync(projects)) return out;
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${sid}.jsonl`);
    if (file !== preferred && existsSync(file)) out.push(file);
  }
  return out;
}

export const claudeContinuity: HarnessContinuityCapability = {
  async locate(ref, env) {
    const found = transcriptCandidates(claudeStoreDir(env), ref.nativeSessionId, ref.cwd)
      .map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }))
      // Newest wins on a tie (a session resumed under another cwd writes there).
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (!found) return { found: false };
    const sidecar = join(found.file.slice(0, -".jsonl".length));
    return {
      found: true,
      file: found.file,
      mtimeMs: found.mtimeMs,
      sidecars: existsSync(sidecar) && statSync(sidecar).isDirectory() ? [sidecar] : [],
    };
  },

  async move(located, _fromEnv, toEnv, targetCwd) {
    const sid = located.nativeSessionId ?? basename(located.file, ".jsonl");
    const targetDir = join(claudeStoreDir(toEnv), "projects", claudeProjectDirName(targetCwd));
    const dest = join(targetDir, `${sid}.jsonl`);
    if (dest === located.file) return { ok: true, resumeRef: { nativeSessionId: sid } };
    const copied: string[] = [];
    try {
      mkdirSync(targetDir, { recursive: true });
      copied.push(dest);
      copyFileSync(located.file, dest);
      if (statSync(dest).size !== statSync(located.file).size)
        throw new Error("transcript copy size mismatch");
      for (const sidecar of located.sidecars) {
        const destDir = join(targetDir, basename(sidecar));
        copied.push(destDir);
        cpSync(sidecar, destDir, { recursive: true });
        if (!existsSync(destDir)) throw new Error("sidecar copy missing");
      }
    } catch (err) {
      for (const dest of copied) rmSync(dest, { recursive: true, force: true });
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    // The engine publishes the destination holder before invoking retirement.
    return {
      ok: true,
      resumeRef: { nativeSessionId: sid },
      retire() {
        rmSync(located.file, { force: true });
        for (const sidecar of located.sidecars) rmSync(sidecar, { recursive: true, force: true });
      },
    };
  },

  /** On a RESUMED try (the engine asks only then) an API 400 is the vendor
   * refusing the request built from the carried transcript. */
  rejectsCarriedState(ev) {
    return ev.type === "error" && ev.payload?.["api_error_status"] === 400;
  },
};
