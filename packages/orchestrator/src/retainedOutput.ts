import { writeRetainedOutput } from "@claudexor/event-log";
import { redactSecrets } from "@claudexor/util";
import type { AnnouncedRunContext } from "./runTerminalContext.js";

/** A readable projection is independent of acceptance and never masks the original terminal. */
export function publishRetainedOutput(context: AnnouncedRunContext, succeeded: boolean): void {
  try {
    const source = context.log.readAll();
    const path = writeRetainedOutput(context.paths.root, source, succeeded);
    if (!path) return;
    const lastOutput = source.events.findLast((event) => event.type === "output.ready");
    context.log.emit("output.ready", {
      kind: "report",
      path,
      state: succeeded && lastOutput?.payload["state"] !== "diagnostic" ? "ready" : "diagnostic",
    });
  } catch (error) {
    try {
      context.log.emit("harness.event", {
        type: "status",
        title: "Retained output could not be saved",
        text: redactSecrets(`Retained output could not be saved: ${String(error)}`),
        payload: { retained_output_failed: true },
      });
    } catch {
      /* Preserve the original terminal even when its log is unwritable. */
    }
  }
}
