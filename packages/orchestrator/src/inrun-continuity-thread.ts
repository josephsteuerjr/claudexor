/** Thread disclosure is separate from publishing a session/checkpoint. */
import type { ContinuedTry } from "./inrun-continuity-carrier.js";
import type { InRunContinuityDeps } from "./inrun-continuity-types.js";

export function discloseContinuedTry(
  deps: InRunContinuityDeps,
  continued: ContinuedTry,
  laneSwitch: { harness: string; profileId: string | null } | null,
): void {
  const thread = deps.thread;
  if (!thread || (continued.carrier !== "packet" && continued.carrier !== "native_moved")) return;
  const kind = continued.carrier === "packet" ? "packet" : "native_resume";
  deps.emit("session.continuity", {
    thread_id: thread.threadId,
    harness_id: deps.adapter.id,
    kind,
    packet_turns: 0,
    summarized: continued.summarized,
    ...(laneSwitch ? { lane_switched_from: laneSwitch } : {}),
    ...(continued.carrier === "native_moved" ? { moved: true } : {}),
  });
  if (thread.turnId)
    thread.onContinuityResolved?.(thread.turnId, {
      kind,
      packetTurns: 0,
      summarized: continued.summarized,
      laneSwitchedFrom: laneSwitch,
    });
}
