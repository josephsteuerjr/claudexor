import { describe, expect, it } from "vitest";
import { EffortResolution } from "@claudexor/schema";
import { effortVariantFamily, selectEffortVariant } from "./effort-variants.js";

/**
 * Frozen slice of the live `cursor@valintine` inventory (daemon 3.19.0 snapshot,
 * 246 ids / 52 families, probed by both V3B roasts). Ids only: the vendor's
 * labels ("Grok 4.7 Extra High", "GPT-5.5 1M Extra High") are never read, and
 * the list order is deliberately NOT weakest→strongest — it is a menu, not a
 * ladder.
 */
const CATALOG = [
  "grok-4.7-high",
  "grok-4.7-low",
  "grok-4.7-medium",
  "grok-4.7-xhigh",
  "grok-4.7-high-fast",
  "grok-4.7-low-fast",
  "grok-4.7-medium-fast",
  "grok-4.7-xhigh-fast",
  "cursor-grok-4.6-high",
  "cursor-grok-4.6-low",
  "cursor-grok-4.6-medium",
  "cursor-grok-4.6-xhigh",
  "cursor-grok-4.6-high-fast",
  "cursor-grok-4.6-low-fast",
  "cursor-grok-4.6-medium-fast",
  "cursor-grok-4.6-xhigh-fast",
  "gpt-5.5-high",
  "gpt-5.5-low",
  "gpt-5.5-medium",
  "gpt-5.5-none",
  "gpt-5.5-extra-high",
  "gpt-5.5-extra-high-fast",
  "gpt-5.4-high",
  "gpt-5.4-low",
  "gpt-5.4-medium",
  "gpt-5.4-xhigh",
  "gpt-5.4-high-fast",
  "gpt-5.4-medium-fast",
  "gpt-5.4-xhigh-fast",
  "claude-fable-5-high",
  "claude-fable-5-low",
  "claude-fable-5-max",
  "claude-fable-5-medium",
  "claude-fable-5-xhigh",
  "claude-fable-5-thinking-high",
  "claude-fable-5-thinking-low",
  "claude-fable-5-thinking-max",
  "claude-fable-5-thinking-medium",
  "claude-fable-5-thinking-xhigh",
  "claude-4.6-opus-high",
  "claude-4.6-opus-max",
  "claude-4.6-opus-high-thinking",
  "claude-4.6-opus-max-thinking",
  "claude-opus-5-high",
  "claude-opus-5-low",
  "claude-opus-5-medium",
  "claude-opus-5-thinking-high",
  "claude-opus-5-thinking-low",
  "claude-opus-5-thinking-max",
  "claude-opus-5-thinking-medium",
  "claude-opus-5-thinking-xhigh",
  "gpt-5.3-codex",
  "gpt-5.3-codex-high",
  "gpt-5.3-codex-low",
  "gpt-5.3-codex-xhigh",
  "kimi-k3-high",
  "kimi-k3-low",
  "kimi-k3-max",
  "auto",
  "composer-2.5",
  "composer-2.5-fast",
  "claude-4.5-sonnet",
];

const select = (requested: string | null | undefined, model: string | null, catalog = CATALOG) =>
  selectEffortVariant(requested, model, catalog);

describe("family of a compound id", () => {
  it("removes exactly one shared-order token and keeps every other token in the key", () => {
    expect(effortVariantFamily("grok-4.7-xhigh-fast")).toEqual({
      key: "grok-4.7-fast",
      level: "xhigh",
    });
    expect(effortVariantFamily("claude-4.6-opus-high-thinking")).toEqual({
      key: "claude-4.6-opus-thinking",
      level: "high",
    });
    expect(effortVariantFamily("gpt-5.5-extra-high")).toEqual({
      key: "gpt-5.5-extra",
      level: "high",
    });
  });
  it("treats a bare id as its own key and a two-token id as ambiguous", () => {
    expect(effortVariantFamily("grok-4.7")).toEqual({ key: "grok-4.7", level: null });
    expect(effortVariantFamily("composer-2.5-fast")).toEqual({
      key: "composer-2.5-fast",
      level: null,
    });
    expect(effortVariantFamily("gpt-5.1-codex-max-high")).toBeNull();
  });
});

describe("effort selects the listed variant of the same family (roast vectors)", () => {
  it("grok-4.7-xhigh-fast: max → downward to xhigh-fast, low → exact, none → floor, ultra → downward", () => {
    const model = "grok-4.7-xhigh-fast";
    expect(select("max", model)).toMatchObject({
      model: "grok-4.7-xhigh-fast",
      effort: { requested: "max", submitted: "xhigh", resolution: "downward" },
    });
    expect(select("low", model)).toMatchObject({
      model: "grok-4.7-low-fast",
      effort: { requested: "low", submitted: "low", resolution: "exact" },
    });
    expect(select("none", model)).toMatchObject({
      model: "grok-4.7-low-fast",
      effort: { requested: "none", submitted: "low", resolution: "floor" },
    });
    expect(select("ultra", model)).toMatchObject({
      model: "grok-4.7-xhigh-fast",
      effort: { requested: "ultra", submitted: "xhigh", resolution: "downward" },
    });
  });

  it("fast stays fast: the level never crosses the fast/standard boundary", () => {
    for (const word of ["max", "low", "none", "ultra", "medium"]) {
      expect(select(word, "grok-4.7-xhigh-fast").model).toMatch(/-fast$/);
      expect(select(word, "grok-4.7-xhigh").model).not.toMatch(/-fast$/);
    }
  });

  it("a word outside the shared order leaves the id unchanged, omitted, with a note — never a refusal", () => {
    const out = select("ulta", "grok-4.7-xhigh-fast");
    expect(out.model).toBe("grok-4.7-xhigh-fast");
    expect(out.effort).toMatchObject({
      requested: "ulta",
      submitted: null,
      resolution: "omitted",
      parameter: "--model",
    });
    expect(out.effort.reason).toContain("outside the shared preference order");
    expect(out.effort.reason).toContain("unchanged");
  });

  it("no preference → the id as written, omitted, no note", () => {
    for (const requested of [null, undefined, ""]) {
      const out = select(requested, "grok-4.7-xhigh-fast");
      expect(out.model).toBe("grok-4.7-xhigh-fast");
      expect(out.effort).toMatchObject({ requested: null, submitted: null, resolution: "omitted" });
      expect(out.effort.reason).toBeUndefined();
    }
  });

  it("a bare family id selects its listed sibling: grok-4.7 + max → grok-4.7-xhigh", () => {
    expect(select("max", "grok-4.7")).toMatchObject({
      model: "grok-4.7-xhigh",
      effort: { submitted: "xhigh", resolution: "downward" },
    });
    expect(select("low", "grok-4.7")).toMatchObject({ model: "grok-4.7-low" });
    expect(select(null, "grok-4.7").model).toBe("grok-4.7");
  });

  it("an unlisted explicit id selects a listed family variant only with an effort preference", () => {
    const model = "grok-4.7-ultra";
    expect(CATALOG).not.toContain(model);
    expect(select("max", model)).toMatchObject({
      model: "grok-4.7-xhigh",
      effort: { submitted: "xhigh", resolution: "downward", parameter: "--model" },
    });
    expect(select(null, model).model).toBe(model);
  });

  it("a listed bare id (gpt-5.3-codex) keeps itself without effort and selects a sibling with one", () => {
    expect(select(null, "gpt-5.3-codex").model).toBe("gpt-5.3-codex");
    expect(select("xhigh", "gpt-5.3-codex")).toMatchObject({
      model: "gpt-5.3-codex-xhigh",
      effort: { resolution: "exact" },
    });
  });

  it("extra-high is not a synonym: gpt-5.5-extra-high is a single id outside the gpt-5.5 family", () => {
    expect(select("max", "gpt-5.5-high")).toMatchObject({
      model: "gpt-5.5-high",
      effort: { submitted: "high", resolution: "downward" },
    });
    const extra = select("max", "gpt-5.5-extra-high");
    expect(extra.model).toBe("gpt-5.5-extra-high");
    expect(extra.effort.resolution).toBe("omitted");
    expect(extra.effort.reason).toContain('family "gpt-5.5-extra"');
    expect(select("low", "gpt-5.5-extra-high").model).toBe("gpt-5.5-extra-high");
  });

  it("thinking stays on its side: claude-fable-5-high + max → claude-fable-5-max (not thinking)", () => {
    expect(select("max", "claude-fable-5-high")).toMatchObject({
      model: "claude-fable-5-max",
      effort: { submitted: "max", resolution: "exact" },
    });
    expect(select("max", "claude-fable-5-thinking-high").model).toBe("claude-fable-5-thinking-max");
  });

  it("a level token in the middle: claude-4.6-opus-high-thinking + max → claude-4.6-opus-max-thinking", () => {
    expect(select("max", "claude-4.6-opus-high-thinking")).toMatchObject({
      model: "claude-4.6-opus-max-thinking",
      effort: { submitted: "max", resolution: "exact" },
    });
  });

  it("max listed only in the thinking family does not pull the plain family across", () => {
    expect(select("max", "claude-opus-5-high")).toMatchObject({
      model: "claude-opus-5-high",
      effort: { submitted: "high", resolution: "downward" },
    });
  });

  it("asymmetric fast ladder: gpt-5.4-xhigh-fast + low → floor gpt-5.4-medium-fast, never gpt-5.4-low", () => {
    expect(select("low", "gpt-5.4-xhigh-fast")).toMatchObject({
      model: "gpt-5.4-medium-fast",
      effort: { submitted: "medium", resolution: "floor" },
    });
    expect(select("low", "gpt-5.4-xhigh")).toMatchObject({ model: "gpt-5.4-low" });
  });

  it("kimi-k3-max is the same product's max level", () => {
    expect(select("max", "kimi-k3-high").model).toBe("kimi-k3-max");
    expect(select("medium", "kimi-k3-max")).toMatchObject({
      model: "kimi-k3-low",
      effort: { resolution: "downward" },
    });
  });

  it("ids without a family stay unchanged: auto, composer-2.5(-fast), claude-4.5-sonnet", () => {
    for (const id of ["auto", "composer-2.5", "composer-2.5-fast", "claude-4.5-sonnet"]) {
      const out = select("max", id);
      expect(out.model).toBe(id);
      expect(out.effort).toMatchObject({
        requested: "max",
        submitted: null,
        resolution: "omitted",
      });
      expect(out.effort.reason).toContain("no second level");
    }
  });

  it("an empty catalog keeps the id and says why (never the static hint list)", () => {
    const out = selectEffortVariant(
      "max",
      "grok-4.7-high",
      [],
      "the account model list could not be read",
    );
    expect(out.model).toBe("grok-4.7-high");
    expect(out.effort).toMatchObject({
      requested: "max",
      submitted: null,
      resolution: "omitted",
      source: "adapter",
      parameter: "--model",
    });
    expect(out.effort.reason).toContain("could not be read");
  });

  it("an ambiguous id (two shared-order tokens) is kept as is — no last-token-wins guess", () => {
    const catalog = [...CATALOG, "gpt-5.1-codex-max-high", "gpt-5.1-codex-max-low"];
    const out = selectEffortVariant("low", "gpt-5.1-codex-max-high", catalog);
    expect(out.model).toBe("gpt-5.1-codex-max-high");
    expect(out.effort.resolution).toBe("omitted");
    expect(out.effort.reason).toContain("ambiguous");
  });

  it("a level that maps to two listed ids drops the family instead of guessing a position", () => {
    const out = selectEffortVariant("low", "a-high-b", ["a-high-b", "a-b-high", "a-b-low"]);
    expect(out.model).toBe("a-high-b");
    expect(out.effort.resolution).toBe("omitted");
  });

  it("ranks only by the shared order, whatever order the vendor lists the ids in", () => {
    const shuffled = [...CATALOG].reverse();
    expect(selectEffortVariant("medium", "z-high", ["z-high", "z-low"]).model).toBe("z-low");
    expect(selectEffortVariant("max", "grok-4.7-low", shuffled).model).toBe("grok-4.7-xhigh");
    expect(selectEffortVariant("none", "grok-4.7-low", shuffled).model).toBe("grok-4.7-low");
  });

  it("a single listed level is not a family", () => {
    expect(selectEffortVariant("low", "solo-high", ["solo-high", "other-low"])).toMatchObject({
      model: "solo-high",
      effort: { resolution: "omitted" },
    });
  });

  it("no model → nothing to select", () => {
    expect(select("max", null)).toMatchObject({
      model: null,
      effort: { requested: "max", resolution: "omitted", source: "adapter" },
    });
  });

  it("every receipt is a valid strict EffortResolution with the --model carrier and no observation", () => {
    for (const [requested, model] of [
      ["max", "grok-4.7-xhigh-fast"],
      ["ulta", "grok-4.7"],
      [null, "auto"],
      ["low", "gpt-5.5-extra-high"],
      ["high", null],
    ] as const) {
      const { effort } = select(requested, model);
      expect(EffortResolution.parse(effort)).toEqual(effort);
      expect(effort).toMatchObject({ parameter: "--model", observed: null, observedSource: null });
      expect(effort.requested).toBe(requested ?? null);
    }
    const chosen = select("max", "grok-4.7-high").effort;
    expect(chosen.source).toBe("account_catalog");
    expect(chosen.reason).toContain('selected the listed variant "grok-4.7-xhigh"');
    expect(chosen.reason).toContain('requested model "grok-4.7-high"');
    expect(chosen.reason).toContain("claims no vendor support");
  });
});
