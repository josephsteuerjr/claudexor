/**
 * Inline CLI presentation of a durable managed login job.
 *
 * Bootstrap logins and Codex profile logins use the daemon-owned setup job.
 * This helper polls the job snapshot,
 * shows the one-time code + verification URL as soon as the runner discloses
 * them (transient, from the snapshot overlay — never journaled), and follows
 * the job to its typed terminal outcome. Ctrl-C detaches the CLI; the daemon
 * runner keeps the login alive.
 */
import {
  ControlSetupJob,
  ControlSetupJobInputRequest,
  ControlSetupJobSnapshot,
  isTerminalControlSetupJobState,
  type ControlSetupJobState,
} from "@claudexor/schema";
import { print, printJson } from "./cli-io.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";

import {
  createTerminalFallbackJob,
  defaultPromptYesNo,
  terminalLoginFallback,
  terminalLoginReport,
  type FetchLike,
  type TerminalLoginFallbackCapability,
} from "./setup-login-fallback.js";
import { promptLoginInput } from "./setup-login-input-prompt.js";

const POLL_MS = 1_000;

export interface StreamDurableLoginOptions {
  label: string;
  /** `--json`: emit exactly one JSON object (the disclosure, the terminal
   * outcome, or a detached/ error envelope) instead of the human stream. */
  json?: boolean;
  /** Enables the one-action Terminal fallback on a device_auth_unsupported
   * miss (a y/N prompt on a TTY; a typed `nextAction` in `--json`). */
  fallback?: TerminalLoginFallbackCapability;
  /** Ordinary CLI detach is success; ACP terminal auth must report cancellation as non-success. */
  detachExitCode?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  promptYesNo?: (question: string) => Promise<boolean>;
  fetchImpl?: FetchLike;
  isTTY?: boolean;
  /** The exact invoking command, for returning to its still-active job. */
  resumeCommand?: string;
  promptInput?: (question: string, signal: AbortSignal) => Promise<string | null>;
}

/**
 * Follow a managed login job. In TTY mode it displays the current disclosure
 * and follows the job to its terminal outcome; on a device_auth_unsupported
 * miss it OFFERS the legacy Terminal sign-in (a y/N prompt that, on yes, starts
 * the browser_redirect job in one action). In `--json` mode it emits one JSON
 * object: the transient disclosure (so a caller can complete the sign-in), the
 * terminal outcome (with a typed `nextAction` on the fallback), or a
 * detached/error envelope. Returns the process exit code (0 on success).
 */
export async function streamDurableLogin(
  addr: ControlApiAddress,
  jobId: string,
  opts: StreamDurableLoginOptions = { label: "codex" },
): Promise<number> {
  const { label } = opts;
  const json = opts.json ?? false;
  const pollMs = opts.pollMs ?? POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const fetchImpl: FetchLike =
    opts.fetchImpl ?? ((path, init) => controlApiFetch(addr, path, init));
  const promptYesNo = opts.promptYesNo ?? defaultPromptYesNo;
  let disclosed = "";
  const inputAbort = new AbortController();
  let inputStarted = false;
  let inputResult: { value: string | null } | { error: unknown } | undefined;
  let detached = false;
  const onSigint = () => {
    detached = true;
    inputAbort.abort();
  };
  process.once("SIGINT", onSigint);
  try {
    for (;;) {
      if (detached) {
        const detachExitCode = opts.detachExitCode ?? 0;
        if (json) {
          printJson({ ok: detachExitCode === 0, detached: true, jobId });
          return detachExitCode;
        }
        print(
          `Detached. ${label} login keeps running as ${jobId}; ` +
            (opts.resumeCommand
              ? `repeat \`${opts.resumeCommand}\` while it is still active to continue.`
              : "Finish it in the browser, or return through the client that started it."),
        );
        return detachExitCode;
      }
      const response = await fetchImpl(`/setup/jobs/${encodeURIComponent(jobId)}/snapshot`);
      if (!response.ok) {
        if (json) {
          printJson({ ok: false, error: "snapshot_unavailable", status: response.status, jobId });
          return 1;
        }
        print(
          `could not read ${label} login status (${response.status}); it keeps running as ${jobId}`,
        );
        return 1;
      }
      const snapshot = ControlSetupJobSnapshot.parse(await response.json());
      const job = snapshot.job;
      if (job.jobId !== jobId) throw new Error("setup snapshot does not match the requested login");
      const jobLabel = job.profileId ? `${job.harness}/${job.profileId}` : job.harness;
      const terminal = isTerminalControlSetupJobState(job.state as ControlSetupJobState);

      if (json) {
        // Return promptly once we know the flow's shape: a disclosure means the
        // app-server supports device-code (hand the caller the code/URL); a
        // terminal state (e.g. the fast device_auth_unsupported miss) carries
        // the typed nextAction. This keeps `--json` bounded — it never blocks
        // waiting for a human to finish the browser step.
        if (!terminal && snapshot.deviceCode) {
          printJson({
            ok: true,
            job,
            deviceCode: {
              flow: snapshot.deviceCode.flow,
              verificationUrl: snapshot.deviceCode.verificationUrl,
              userCode: snapshot.deviceCode.userCode,
            },
            ...(snapshot.deviceCode.flow === "oauth_url_input"
              ? {
                  nextAction: {
                    kind: "submit_sign_in_input",
                    method: "POST",
                    path: `/v2/setup/jobs/${encodeURIComponent(jobId)}/input`,
                    jobId,
                  },
                }
              : {}),
          });
          return 0;
        }
        if (terminal) {
          const nextAction = terminalLoginFallback(job);
          printJson({ ok: job.state === "succeeded", job, ...(nextAction ? { nextAction } : {}) });
          return job.state === "succeeded" ? 0 : 1;
        }
        await sleep(pollMs);
        continue;
      }

      // TTY mode.
      const disclosureKey = JSON.stringify(snapshot.deviceCode ?? null);
      if (snapshot.deviceCode && disclosureKey !== disclosed) {
        disclosed = disclosureKey;
        print("");
        print(`Open:    ${snapshot.deviceCode.verificationUrl}`);
        if (snapshot.deviceCode.userCode) print(`Code:    ${snapshot.deviceCode.userCode}`);
        print(`Waiting for ${job.harness}… (Ctrl-C detaches; the login keeps running)`);
        print("");
      }
      if (terminal) {
        // device_auth_unsupported is a real fork, not a dead end: OFFER to start
        // the legacy Terminal sign-in in one action (explicit y/N — never a
        // silent fallback). Declining, or a non-TTY, falls back to the typed
        // report that names the exact next command.
        const nextAction = terminalLoginFallback(job);
        if (opts.fallback && nextAction) {
          const fallbackLabel = nextAction.profileId ? `codex/${nextAction.profileId}` : "codex";
          print(
            `${fallbackLabel} login not_supported (device_auth_unsupported): this codex build has no in-app device-code sign-in.`,
          );
          const yes = await promptYesNo(
            "Start the legacy Terminal (browser-redirect) sign-in now? [y/N] ",
          );
          if (yes) return await createTerminalFallbackJob(fetchImpl, nextAction, fallbackLabel);
          print(
            nextAction.profileId
              ? "You can retry this profile with the legacy Terminal (browser-redirect) sign-in later."
              : "You can start it later with `claudexor auth login codex --browser-redirect`.",
          );
          return 1;
        }
        const report = terminalLoginReport(job, jobLabel);
        for (const line of report.lines) print(line);
        return report.exitCode;
      }
      if (snapshot.deviceCode?.flow === "oauth_url_input" && !inputStarted) {
        if (!(opts.isTTY ?? process.stdin.isTTY)) {
          print(
            `This sign-in needs a code. Continue in an interactive terminal${opts.resumeCommand ? ` with \`${opts.resumeCommand}\`` : ""}, or POST the code to /v2/setup/jobs/${encodeURIComponent(jobId)}/input. The same login is still running.`,
          );
          return 1;
        }
        inputStarted = true;
        void (opts.promptInput ?? promptLoginInput)(
          "Paste the sign-in code: ",
          inputAbort.signal,
        ).then(
          (value) => {
            inputResult = { value };
          },
          (error) => {
            inputResult = { error };
          },
        );
      }
      if (inputStarted && job.phase !== "awaiting_user") inputAbort.abort();
      if (inputResult && !detached && snapshot.deviceCode?.flow === "oauth_url_input") {
        const result = inputResult;
        inputResult = undefined;
        if ("error" in result) throw result.error;
        if (result.value === null) {
          print(`No code was submitted. ${jobLabel} login keeps running as ${jobId}.`);
          return 1;
        }
        const body = ControlSetupJobInputRequest.parse({ value: result.value.trim() });
        const submitted = await fetchImpl(`/setup/jobs/${encodeURIComponent(jobId)}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!submitted.ok) {
          const problem = (await submitted.json()) as { code?: string };
          if (submitted.status === 409 && problem.code === "setup_input_already_submitted") {
            print("A code was already submitted for this login. Waiting for its result…");
            await sleep(pollMs);
            continue;
          }
          print(
            `Sign-in input was not confirmed (${submitted.status}). Read the status of ${jobId} before submitting again.`,
          );
          return 1;
        }
        const updated = ControlSetupJob.parse(await submitted.json());
        if (updated.jobId !== jobId)
          throw new Error("setup input response does not match the requested login");
        print(`Code delivered. Waiting for ${job.harness} to finish the sign-in…`);
      }
      await sleep(pollMs);
    }
  } finally {
    inputAbort.abort();
    process.removeListener("SIGINT", onSigint);
  }
}
