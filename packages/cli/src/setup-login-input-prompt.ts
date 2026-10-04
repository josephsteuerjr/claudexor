import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Keep the prompt cancellable while the independent snapshot observer runs. */
export function promptLoginInput(
  question: string,
  signal: AbortSignal,
  streams: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout },
): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface(streams);
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      rl.close();
      resolve(value);
    };
    const abort = () => finish(null);
    rl.once("close", abort);
    // A terminal readline owns Ctrl-C instead of the process signal handler.
    // Hand it to the existing follower's detach handler.
    rl.once("SIGINT", () => process.emit("SIGINT"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else rl.question(question, (value) => finish(value));
  });
}
