import { describe, expect, it } from "vitest";
import { commandActivityRecords } from "./command-activity.js";
import { publicJobRecord, type JobRecord } from "./job-record.js";

describe("in-process project and retention activity", () => {
  it("keeps global and project scopes without walking prompt bodies", () => {
    const rows: JobRecord[] = ["global", "project"].map((id) => ({
      id,
      runId: `run-${id}`,
      state: "running",
      createdAt: "2026-10-08T00:00:00Z",
      params: {
        scope: id === "global" ? { kind: "none" } : { kind: "project", root: "/fixture/project" },
        request: {
          get prompt() {
            throw new Error("body traversed");
          },
        },
      },
    }));
    expect(commandActivityRecords(rows)).toEqual(
      rows.map((r) => ({
        runId: r.runId,
        state: r.state,
        finishedAt: undefined,
        params: { scope: (r.params as { scope: unknown }).scope },
      })),
    );
    // The retention trash fence matches a live turn by its thread id.
    const turn = { ...rows[1]!, params: { ...(rows[1]!.params as object), threadId: "t-1" } };
    expect(commandActivityRecords([turn])[0]?.params).toEqual({
      scope: (rows[1]!.params as { scope: unknown }).scope,
      threadId: "t-1",
    });
    expect(() => rows.map(publicJobRecord)).toThrow("body traversed");
    expect(
      commandActivityRecords([
        { ...rows[0]!, id: "delivery-old" },
        { ...rows[0]!, params: { kind: "model" } },
      ]),
    ).toEqual([]);
  });
});
