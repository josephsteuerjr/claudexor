import { HarnessUnavailableError, type HarnessAdapter } from "@claudexor/core";
import { ConformanceReport } from "@claudexor/schema";
import type { AcpEntry } from "./entry.js";
import { acpCapabilityProfile } from "./manifest.js";
import { acpRunner } from "./run.js";
export { copilot } from "./entry.js";

/** A vendor identity over the shared ACP v1 transport. */
export function createAcpAdapter(entry: AcpEntry): HarnessAdapter {
  const runner = acpRunner(entry);
  const unavailable = () =>
    new HarnessUnavailableError(`${entry.displayName} ACP transport is not ready`);
  return {
    id: entry.id,
    capabilityProfile: acpCapabilityProfile(),
    async discover() {
      throw unavailable();
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: entry.id,
        status: "unavailable",
        reasons: [unavailable().message],
      });
    },
    run: runner.run,
    cancel: runner.cancel,
  };
}
