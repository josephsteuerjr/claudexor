import { expect, it } from "vitest";
import { effortRankLadder, resolveEffort } from "./effort.js";

it("uses the strongest supported level below the preference even when an upper level is nearer", () => {
  expect(
    resolveEffort("xhigh", ["low", "max"], ["low", "medium", "high", "xhigh", "max"]),
  ).toMatchObject({ status: "ok", effort: "low", clamped: true, placedBy: "vendor" });
});

it("uses the known minimum only when every supported level exceeds the preference", () => {
  expect(resolveEffort("none", ["high", "max"], ["none", "low", "high", "max"])).toMatchObject({
    status: "ok",
    effort: "high",
    clamped: true,
    placedBy: "vendor",
  });
  expect(resolveEffort("none", ["high", "unranked"], ["none", "low", "high"]).status).toBe(
    "rejected",
  );
});

it("retains an exact future token and keeps default omission distinct from none", () => {
  expect(resolveEffort("future", ["future"]).status).toBe("ok");
  expect(resolveEffort("none", ["none", "high"])).toMatchObject({
    status: "ok",
    effort: "none",
    clamped: false,
    placedBy: null,
  });
  expect(resolveEffort(null, ["none", "high"])).toMatchObject({
    status: "ok",
    effort: null,
    clamped: false,
    placedBy: null,
  });
});

it("does not turn display tie-breaking between unrelated ladders into effort ranks", () => {
  const ladder = effortRankLadder([
    ["low", "high"],
    ["mild", "strong"],
  ]);
  expect(resolveEffort("strong", ["low", "high"], ladder).status).toBe("rejected");
  expect(resolveEffort("strong", ["strong"], ladder)).toMatchObject({
    status: "ok",
    effort: "strong",
    clamped: false,
  });
});
