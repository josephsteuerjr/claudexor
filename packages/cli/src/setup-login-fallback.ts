import { createInterface } from "node:readline/promises";
import { ControlSetupJob } from "@claudexor/schema";
import { print } from "./cli-io.js";

const NEGATIVE_TERMINAL_STATES = ["failed", "cancelled", "timed_out", "not_supported"];

/** Capability to offer the legacy Terminal (browser_redirect) continuation.
 * Its target is deliberately absent: only the server-owned job may select the
 * credential store that an existing setup flow continues. */
export interface TerminalLoginFallbackCapability {
  harness: "codex";
}

/**
 * D-17 audit point 8: the typed, machine-actionable next step for a codex
 * device-code login that terminalized as `not_supported` because the installed
 * app-server (or an old codex CLI) lacks the typed auth methods. It is the SAME
 * consistent code — `device_auth_unsupported` — that the runner result, the
 * journaled receipt, the control DTO, and the Swift AuthSheet all key off; here
 * it drives the `--json` `nextAction` so a script pivots to the Terminal flow
 * instead of parsing prose.
 */
export interface TerminalLoginNextAction {
  kind: "terminal_login_fallback";
  reason: "device_auth_unsupported";
  loginFlow: "browser_redirect";
  /** Exact server-owned credential target; null = the default store. */
  profileId: string | null;
}

function hasTerminalLoginFallback(
  job: Pick<ControlSetupJob, "harness" | "state" | "nativeCommand">,
): boolean {
  return (
    job.harness === "codex" &&
    job.state === "not_supported" &&
    job.nativeCommand?.errorCode === "device_auth_unsupported"
  );
}

/** The typed next action for a terminal job, or null for an ordinary outcome.
 * The target comes from the server-owned job so every machine producer agrees. */
export function terminalLoginFallback(
  job: Pick<ControlSetupJob, "harness" | "state" | "nativeCommand" | "profileId">,
): TerminalLoginNextAction | null {
  if (hasTerminalLoginFallback(job)) {
    return {
      kind: "terminal_login_fallback",
      reason: "device_auth_unsupported",
      loginFlow: "browser_redirect",
      profileId: job.profileId,
    };
  }
  return null;
}

/**
 * D-17 audit point 8: the terminal report for a durable codex login. The
 * `not_supported` state is actionable, not a dead-end message: when the daemon
 * carries the consistent typed code `device_auth_unsupported` on the
 * native-command receipt (the SAME code the runner result, journal, control
 * DTO, and Swift surface use), the CLI names the code AND the exact next step
 * (the legacy Terminal sign-in), and exits non-zero. Used for the non-TTY /
 * declined path; a TTY OFFERS the transition directly (see below).
 */
export function terminalLoginReport(
  job: Pick<ControlSetupJob, "harness" | "state" | "message" | "nativeCommand" | "profileId">,
  label: string,
): { lines: string[]; exitCode: number } {
  const nextAction = terminalLoginFallback(job);
  if (nextAction) {
    const fallbackLabel = nextAction.profileId ? `codex/${nextAction.profileId}` : "codex";
    return {
      lines: [
        `${fallbackLabel} login not_supported (device_auth_unsupported): this codex build has no in-app device-code sign-in.`,
        nextAction.profileId
          ? "Next: retry this profile with the legacy Terminal sign-in (the browser-redirect flow)."
          : "Next: run `claudexor auth login codex --browser-redirect` for the Terminal sign-in.",
      ],
      exitCode: 1,
    };
  }
  return {
    lines: [`${label} login ${job.state}: ${job.message}`],
    exitCode: job.state === "succeeded" ? 0 : 1,
  };
}

/** Minimal structural view of the control-plane transport so tests can drive
 * the stream without a live daemon. Defaults to the real `controlApiFetch`. */
export type FetchLike = (
  path: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

/** Default TTY yes/no prompt. Declines (false) when stdin is not a TTY so a
 * non-interactive pipe never blocks waiting for an answer. */
export async function defaultPromptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Create the legacy Terminal (browser_redirect) login for the same target. This
 * rides the daemon's existing duplicate-create / 409 semantics: the prior
 * device-code job is already terminal (not_supported), so no conflict blocks
 * it, and a real conflict surfaces the daemon's reason rather than silently
 * starting a duplicate.
 */
export async function createTerminalFallbackJob(
  fetchImpl: FetchLike,
  nextAction: TerminalLoginNextAction,
  label: string,
): Promise<number> {
  const response = await fetchImpl("/setup/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      harness: "codex",
      action: "login",
      authRequest: "subscription",
      loginFlow: nextAction.loginFlow,
      ...(nextAction.profileId ? { profileId: nextAction.profileId } : {}),
    }),
  });
  if (!response.ok) {
    print(
      `could not start the Terminal ${label} sign-in (${response.status}): ${await response.text()}`,
    );
    return 1;
  }
  const job = ControlSetupJob.parse(await response.json());
  const accepted = !NEGATIVE_TERMINAL_STATES.includes(job.state);
  print(
    accepted
      ? `Opening the Terminal ${label} sign-in (managed by claudexord as ${job.jobId}). Complete it in the Terminal window that opens.`
      : `Terminal ${label} sign-in was not started: ${job.message}`,
  );
  return accepted ? 0 : 1;
}
