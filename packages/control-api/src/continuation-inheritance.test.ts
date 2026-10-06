import { describe, expect, it } from "vitest";
import { ControlRunStartRequest, RUN_START_CLIENT_REJECTED_KEYS } from "@claudexor/schema";
import { resolveContinuationBody } from "./run-continuation-start.js";

const daemon = {
  async list() {
    return [
      {
        id: "job-a",
        runId: "run-a",
        state: "failed",
        params: {
          harnesses: ["first"],
          primaryHarness: "first",
          models: { first: "old" },
          model: "old",
        },
      },
    ];
  },
};

describe("continuation inheritance groups", () => {
  it("persists omitted-model provenance and refuses caller-supplied provenance", async () => {
    const resolved = ControlRunStartRequest.parse(
      await resolveContinuationBody(daemon, { continueFrom: "run-a" }),
    );
    expect(resolved).toMatchObject({
      model: "old",
      models: { first: "old" },
      continueModelInherited: true,
    });
    expect(RUN_START_CLIENT_REJECTED_KEYS).toContain("continueModelInherited");
    await expect(
      resolveContinuationBody(daemon, { continueFrom: "run-a", continueModelInherited: true }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it.each([
    [{ model: "chosen" }, "models"],
    [{ models: { second: "chosen" } }, "model"],
    [{ harnesses: ["second"] }, "primaryHarness"],
    [{ primaryHarness: "second" }, "harnesses"],
  ])("does not mix explicit %o with inherited %s", async (override, absent) => {
    const result = await resolveContinuationBody(daemon, { continueFrom: "run-a", ...override });
    expect(result).toMatchObject(override);
    expect(result).not.toHaveProperty(absent);
    if ("model" in override || "models" in override)
      expect(result).toHaveProperty("continueModelInherited", false);
  });
});
