import { describe, expect, it } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { observeCredentialExecution } from "./credential-execution.js";

describe("credential evidence stream boundary", () => {
  it("keeps native events and cleanup when observer maintenance throws", async () => {
    const spec = HarnessRunSpec.parse({
      session_id: "session-1",
      intent: "explain",
      prompt: "fixture",
      cwd: "/tmp",
    });
    let closed = false;
    async function* source(): AsyncGenerator<HarnessEvent> {
      try {
        yield {
          type: "message",
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          text: "native result",
        };
      } finally {
        closed = true;
      }
    }
    const events = [];
    for await (const event of observeCredentialExecution("fake", spec, source(), () => ({
      observe: () => {
        throw new Error("observation failed");
      },
      finish: () => {
        throw new Error("maintenance failed");
      },
    })))
      events.push(event);
    expect(events).toMatchObject([{ text: "native result" }]);
    expect(closed).toBe(true);
  });
});
