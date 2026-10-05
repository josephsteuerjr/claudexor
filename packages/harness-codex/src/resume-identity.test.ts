import { describe, expect, it } from "vitest";
import { CONTINUITY_IDENTITY_MISMATCH_CODE } from "@claudexor/core";
import { codexResumeIdentityMismatch } from "./resume-identity.js";

describe("codex resume identity check (before turn/start)", () => {
  it("is silent for a fresh thread and for the requested thread", () => {
    expect(
      codexResumeIdentityMismatch({ session_id: "s", resume_session_id: null }, "t-1"),
    ).toBeNull();
    expect(
      codexResumeIdentityMismatch({ session_id: "s", resume_session_id: "t-1" }, "t-1"),
    ).toBeNull();
  });

  it("refuses a recovered stranger thread with the typed code, no turn started", () => {
    const events = codexResumeIdentityMismatch(
      { session_id: "s", resume_session_id: "t-1" },
      "t-9",
    );
    expect(events).not.toBeNull();
    expect(events!.map((e) => e.type)).toEqual(["error", "completed"]);
    expect(events![0]).toMatchObject({
      session_id: "s",
      payload: {
        code: CONTINUITY_IDENTITY_MISMATCH_CODE,
        expected_thread_id: "t-1",
        observed_thread_id: "t-9",
      },
    });
    expect(events![0]!.error).toContain("no turn was started");
    expect(events![1]!.payload).toEqual({ code: CONTINUITY_IDENTITY_MISMATCH_CODE });
  });
});
