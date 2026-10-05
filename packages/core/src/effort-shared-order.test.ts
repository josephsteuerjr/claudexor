import { describe, expect, it } from "vitest";
import { EFFORT_PREFERENCE_ORDER } from "@claudexor/schema";
import {
  effortLadders,
  effortReceipt,
  effortResolutionEvent,
  normalizeEffort,
  resolveEffort,
  resolveEffortEvidence,
} from "./effort.js";

/**
 * The shared preference order is a PLACEMENT fallback, not a rank table: the
 * vendor's own order is tried first, the shared order only places a word the
 * vendor never listed, and the receipt says which order did the placing.
 */
const CLAUDE_SNAPSHOT = ["low", "medium", "high", "xhigh", "max"] as const;
const CODEX_WITH_ULTRA = {
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
} as const;
const CODEX_STALE = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
} as const;

describe("the vendor order is primary; the shared order only places unlisted words", () => {
  const claude = effortLadders([CLAUDE_SNAPSHOT, CLAUDE_SNAPSHOT]);

  it("Claude ultra -> max is a DOWNWARD placement by the shared order, named in the receipt", () => {
    const check = resolveEffort("ultra", CLAUDE_SNAPSHOT, claude);
    expect(check).toMatchObject({ status: "ok", effort: "max", clamped: true, placedBy: "shared" });
    if (check.status !== "ok") throw new Error("expected ok");
    // downward/floor are judged on the ladder that chose the level — the shared one.
    expect(check.ladder).toEqual([...EFFORT_PREFERENCE_ORDER]);
    const receipt = effortReceipt(check, "ultra", "live_probe", "--effort");
    expect(receipt).toMatchObject({ requested: "ultra", submitted: "max", resolution: "downward" });
    expect(receipt.reason).toContain("shared preference order");
    expect(receipt.reason).toContain("neither vendor support");
    // The event discloses the placement on the same ignored-settings channel.
    const event = effortResolutionEvent("s", receipt);
    expect(event.text).toContain("effort=ultra: downward; submitted=max");
    expect(event.payload?.["ignored_settings"]).toEqual([
      expect.stringContaining("shared preference order"),
    ]);
  });

  it.each(["none", "minimal"])(
    "Claude %s -> low is a FLOOR placement by the shared order",
    (word) => {
      const receipt = resolveEffortEvidence(
        word,
        CLAUDE_SNAPSHOT,
        claude,
        "live_probe",
        "--effort",
      );
      expect(receipt).toMatchObject({ requested: word, submitted: "low", resolution: "floor" });
      expect(receipt.reason).toContain("shared preference order");
    },
  );

  it("a known Claude gap still resolves on the VENDOR order, with no shared-order reason", () => {
    const older = ["low", "medium", "high", "max"] as const; // 2.1.89-shaped binary
    const check = resolveEffort("xhigh", older, effortLadders([CLAUDE_SNAPSHOT, older]));
    expect(check).toMatchObject({ status: "ok", effort: "high", placedBy: "vendor" });
    const receipt = effortReceipt(check, "xhigh", "live_probe", "--effort");
    expect(receipt).toMatchObject({ submitted: "high", resolution: "downward" });
    expect(receipt.reason).toBeUndefined();
  });

  it("codex ultra on gpt-5.5 keeps its VENDOR-order clamp when a sibling advertises ultra (unchanged)", () => {
    const ladders = effortLadders(Object.values(CODEX_WITH_ULTRA));
    const check = resolveEffort("ultra", CODEX_WITH_ULTRA["gpt-5.5"], ladders);
    expect(check).toMatchObject({ status: "ok", effort: "xhigh", placedBy: "vendor" });
    expect(effortReceipt(check, "ultra", "live_probe", "model_reasoning_effort")).toMatchObject({
      submitted: "xhigh",
      resolution: "downward",
    });
  });

  it("codex ultra on a STALE catalog with no ultra anywhere is placed by the shared order instead of refused", () => {
    const ladders = effortLadders(Object.values(CODEX_STALE));
    expect(ladders.vendor).not.toContain("ultra");
    const receipt = resolveEffortEvidence(
      "ultra",
      CODEX_STALE["gpt-5.5"],
      ladders,
      "live_probe",
      "model_reasoning_effort",
    );
    expect(receipt).toMatchObject({ submitted: "xhigh", resolution: "downward" });
    expect(receipt.reason).toContain("shared preference order");
  });
});

describe("no new refusals; unknown words stay refused only where a knob exists", () => {
  it("a typo on a route WITH a knob is rejected, naming both orders", () => {
    const check = resolveEffort("ulta", CLAUDE_SNAPSHOT, effortLadders([CLAUDE_SNAPSHOT]));
    expect(check.status).toBe("rejected");
    if (check.status !== "rejected") throw new Error("expected a rejection");
    expect(check.message).toContain("cannot place");
    expect(check.message).toContain("outside the shared preference order");
    expect(normalizeEffort("ulta", CLAUDE_SNAPSHOT, effortLadders([CLAUDE_SNAPSHOT]))).toBeNull();
  });

  it("an empty ladder keeps `omitted`, and the disclosure notes a word outside the shared order", () => {
    const typo = resolveEffortEvidence("ulta", [], [], "adapter", null);
    expect(typo).toMatchObject({ requested: "ulta", submitted: null, resolution: "omitted" });
    expect(typo.reason).toContain("outside the shared preference order");
    expect(effortResolutionEvent("s", typo).text).toContain("outside the shared preference order");
    // A shared-order word on the same empty ladder: omitted, nothing to note.
    const known = resolveEffortEvidence("high", [], [], "adapter", null);
    expect(known).toMatchObject({ requested: "high", submitted: null, resolution: "omitted" });
    expect(known.reason).toBeUndefined();
  });

  it("an unverifiable ladder keeps `unverifiable`, with the same note for an unknown word", () => {
    const ladders = effortLadders([CLAUDE_SNAPSHOT]);
    expect(
      resolveEffortEvidence("ulta", CLAUDE_SNAPSHOT, ladders, "adapter", "--effort", true),
    ).toMatchObject({
      submitted: null,
      resolution: "unverifiable",
      reason: expect.stringContaining("outside the shared preference order"),
    });
    const known = resolveEffortEvidence(
      "ultra",
      CLAUDE_SNAPSHOT,
      ladders,
      "adapter",
      "--effort",
      true,
    );
    expect(known).toMatchObject({ submitted: null, resolution: "unverifiable" });
    expect(known.reason).toBeUndefined();
  });
});

describe("contradictions never let the shared order invent a rank", () => {
  it("contradictory vendor lists still refuse cross-model clamping (as today), exact still passes", () => {
    const ladders = effortLadders([
      ["low", "high"],
      ["high", "low"],
    ]);
    // Built from the RAW lists, the fallback inherits the contradiction instead of masking it.
    expect(ladders).toEqual({ vendor: [], shared: [] });
    expect(resolveEffort("medium", ["low", "high"], ladders).status).toBe("rejected");
    expect(resolveEffort("ultra", ["low", "high"], ladders).status).toBe("rejected");
    expect(resolveEffort("high", ["low", "high"], ladders)).toMatchObject({ effort: "high" });
  });

  it("a vendor order that contradicts the shared order keeps its own in-vendor clamp", () => {
    // This vendor ranks minimal ABOVE low. Inside its ladder it wins: minimal
    // on a model advertising low/medium clamps DOWN to low along the vendor order.
    const ladders = effortLadders([["low", "minimal", "medium"]]);
    expect(ladders.vendor).toEqual(["low", "minimal", "medium"]);
    expect(ladders.shared).toEqual([]);
    expect(resolveEffort("minimal", ["low", "medium"], ladders)).toMatchObject({
      status: "ok",
      effort: "low",
      placedBy: "vendor",
    });
    // ...while a word only the shared order knows cannot be placed: refused as today.
    expect(resolveEffort("ultra", ["low", "medium"], ladders).status).toBe("rejected");
  });

  it("a vendor-only word above the shared words leaves the shared fallback unavailable (disclosed limit)", () => {
    const ladders = effortLadders([["low", "high", "ludicrous"]]);
    expect(ladders.vendor).toEqual(["low", "high", "ludicrous"]);
    expect(ladders.shared).toEqual([]);
    expect(resolveEffort("ultra", ["low", "high", "ludicrous"], ladders).status).toBe("rejected");
    expect(resolveEffort("ludicrous", ["low", "high", "ludicrous"], ladders)).toMatchObject({
      effort: "ludicrous",
      clamped: false,
    });
  });

  it("a bare ladder is vendor-only: no shared fallback is implied", () => {
    expect(resolveEffort("ultra", CLAUDE_SNAPSHOT, CLAUDE_SNAPSHOT).status).toBe("rejected");
    expect(resolveEffort("none", CLAUDE_SNAPSHOT).status).toBe("rejected");
  });
});

describe("combinatorial probe: every (route, word) pair keeps the invariants", () => {
  const words = [...EFFORT_PREFERENCE_ORDER, "ulta", "hyperdrive"];
  const ranges: (readonly string[])[] = [];
  for (let start = 0; start < EFFORT_PREFERENCE_ORDER.length; start += 1)
    for (let end = start + 1; end <= EFFORT_PREFERENCE_ORDER.length; end += 1)
      ranges.push(EFFORT_PREFERENCE_ORDER.slice(start, end));
  const routes = ranges.flatMap((advertised) => [
    { advertised, raw: [advertised] },
    { advertised, raw: [advertised, [...EFFORT_PREFERENCE_ORDER.slice(2)]] }, // a low..ultra sibling
    { advertised, raw: [advertised, [...CLAUDE_SNAPSHOT]] },
  ]);
  routes.push(
    { advertised: [], raw: [] },
    { advertised: ["low", "high", "ludicrous"], raw: [["low", "high", "ludicrous"]] },
    {
      advertised: ["low", "high"],
      raw: [
        ["low", "high"],
        ["high", "low"],
      ],
    },
  );

  it(`holds across ${routes.length * words.length} combinations`, () => {
    let shared = 0;
    for (const route of routes) {
      const ladders = effortLadders(route.raw);
      for (const word of words) {
        const check = resolveEffort(word, route.advertised, ladders);
        const receipt = effortReceipt(check, word, "live_probe", "knob");
        // An order can place the word only if it ranks the word AND some advertised level.
        const places = (ladder: readonly string[]) =>
          ladder.includes(word) && route.advertised.some((level) => ladder.includes(level));
        // The argv projection and the receipt come from the same check.
        expect(normalizeEffort(word, route.advertised, ladders)).toBe(receipt.submitted);
        if (route.advertised.includes(word)) {
          expect(check).toMatchObject({ status: "ok", effort: word, clamped: false });
          expect(receipt.resolution).toBe("exact");
          continue;
        }
        if (check.status === "rejected") {
          expect(receipt.resolution).toBe("rejected");
          // Only a word NEITHER order can place onto the advertised set is refused.
          expect(places(ladders.vendor) || places(ladders.shared)).toBe(false);
          expect(route.advertised.length).toBeGreaterThan(0);
          continue;
        }
        if (check.effort === null) {
          expect(route.advertised).toEqual([]);
          expect(receipt.resolution).toBe("omitted");
          continue;
        }
        // A clamped level is always one the route advertises...
        expect(route.advertised).toContain(check.effort);
        // ...and placedBy names the order that ranked it (vendor first), downward/floor judged on it.
        expect(check.placedBy).toBe(places(ladders.vendor) ? "vendor" : "shared");
        if (check.placedBy === "shared") shared += 1;
        const [sent, want] = [check.ladder.indexOf(check.effort), check.ladder.indexOf(word)];
        expect(receipt.resolution).toBe(sent < want ? "downward" : "floor");
        if (receipt.resolution === "floor")
          expect(route.advertised.every((level) => check.ladder.indexOf(level) > want)).toBe(true);
      }
    }
    expect(shared).toBeGreaterThan(0);
  });
});
