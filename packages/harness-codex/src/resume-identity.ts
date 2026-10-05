/**
 * Earliest-handshake identity check for a resumed Codex app-server thread (A4).
 *
 * `thread/resume` answers with the thread it recovered BEFORE any `turn/start`;
 * when that id is not the one `resume_session_id` asked for, the run must not
 * send a turn into a stranger's conversation. The engine reads the typed
 * `payload.code` (never prose) and records `identityCheck:
 * mismatch_before_effects`. A recovered handle is a separate fact from "the
 * current input is in the history" (the turn was never started).
 */
import { CONTINUITY_IDENTITY_MISMATCH_CODE } from "@claudexor/core";
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";

/** The typed error + completed pair to yield instead of starting the turn, or null when the identity matches. */
export function codexResumeIdentityMismatch(
  spec: Pick<HarnessRunSpec, "session_id" | "resume_session_id">,
  recoveredThreadId: string,
): HarnessEvent[] | null {
  const expected = spec.resume_session_id;
  if (!expected || expected === recoveredThreadId) return null;
  const ts = nowIso();
  return [
    {
      type: "error",
      session_id: spec.session_id,
      ts,
      error: `codex app-server recovered thread ${recoveredThreadId} instead of the requested ${expected}; no turn was started`,
      payload: {
        code: CONTINUITY_IDENTITY_MISMATCH_CODE,
        expected_thread_id: expected,
        observed_thread_id: recoveredThreadId,
      },
    },
    {
      type: "completed",
      session_id: spec.session_id,
      ts,
      payload: { code: CONTINUITY_IDENTITY_MISMATCH_CODE },
    },
  ];
}
