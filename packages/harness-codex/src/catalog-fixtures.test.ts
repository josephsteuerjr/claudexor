/* Same-account HTTP catalog pair behind CODEX_HTTP_CLIENT_VERSION (issue #339).
 * On 2026-10-18, 0.156.1 excluded gpt-6.1-sol while 0.163.0 returned it;
 * shared raw parser fields stayed identical. The newly first model becomes the
 * provider-declared default, not a historical default pinned in Claudexor. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODEX_HTTP_CLIENT_VERSION } from "./http-client-version.js";
import { parseCodexModelCatalog } from "./model.js";

const PREVIOUS = "0.156.1";
const RECORDED_AT = "20261018";
const read = (version: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/models-http-${version}-${RECORDED_AT}.json`, import.meta.url),
      "utf8",
    ),
  );

describe(`same-account Codex HTTP catalog at ${PREVIOUS} vs ${CODEX_HTTP_CLIENT_VERSION}`, () => {
  const beforeRaw = read(PREVIOUS) as { models: Array<Record<string, unknown>> };
  const afterRaw = read(CODEX_HTTP_CLIENT_VERSION) as { models: Array<Record<string, unknown>> };
  const before = parseCodexModelCatalog(beforeRaw);
  const after = parseCodexModelCatalog(afterRaw);

  it("keeps shared backend metadata identical while recomputing the provider's first default", () => {
    const rawBySlug = new Map(afterRaw.models.map((model) => [model.slug, model]));
    for (const model of beforeRaw.models) {
      expect(rawBySlug.get(model.slug), `${String(model.slug)} raw metadata changed`).toEqual(
        model,
      );
    }
    const byId = new Map(after.map((entry) => [entry.id, entry]));
    for (const entry of before) {
      const next = byId.get(entry.id);
      expect(next, `${entry.id} disappeared`).toBeDefined();
      expect({ ...next, isDefault: undefined }).toEqual({ ...entry, isDefault: undefined });
    }
    expect(before.find((entry) => entry.isDefault)?.id).toBe("gpt-6-astra");
    expect(after.find((entry) => entry.isDefault)?.id).toBe("gpt-6.1-sol");
  });

  it("exposes only the newly returned gpt-6.1-sol, including its actual metadata", () => {
    expect(CODEX_HTTP_CLIENT_VERSION).toBe("0.163.0");
    const added = after.filter((entry) => !before.some((old) => old.id === entry.id));
    expect(added.map((entry) => entry.id)).toEqual(["gpt-6.1-sol"]);
    expect(added[0]).toMatchObject({
      contextWindow: 500000,
      maxContextWindow: 872000,
      inputModalities: ["text", "image"],
      defaultReasoningEffort: "low",
      reasoningEffortsVerified: true,
    });
    expect(added[0]?.reasoningEfforts).toContain("xhigh");
    // Backend minimal_client_version alone did not predict list visibility:
    // the same account and model was missing at the previous query version.
    expect(afterRaw.models.find((m) => m.slug === "gpt-6.1-sol")?.minimal_client_version).toBe(
      "0.153.0",
    );
    expect(beforeRaw.models.some((m) => m.slug === "gpt-6.1-sol")).toBe(false);
  });
});
