import { HarnessUnavailableError, type HarnessAdapter } from "@claudexor/core";
import { ConformanceReport } from "@claudexor/schema";
import type { AcpEntry } from "./entry.js";
import { acpCapabilityProfile } from "./manifest.js";
export { copilot } from "./entry.js";

/** ACP client adapter; the skeleton refuses until its transport is installed. */
export function createAcpAdapter(entry: AcpEntry): HarnessAdapter {
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
    async *run() {
      throw unavailable();
    },
  };
}
