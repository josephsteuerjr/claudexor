import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedDiff } from "@claudexor/core";
import { containsSecretLikeToken } from "@claudexor/util";

import {
  assertPersistableText,
  buildSecretLikeFinding,
  PERSISTED_PATCH_NOTICE,
  persistedPatchCopy,
} from "./persistedPatch.js";

/** Fake credentials are assembled at runtime; no secret-shaped literal lives here. */
const fakeKey = (fill: string): string => ["sk", fill.repeat(24)].join("-");
const fakeCursorKey = (fill: string): string => ["key", fill.repeat(24)].join("_");
const pemLine = (edge: string): string =>
  `${"-".repeat(5)}${edge} ${["PRIVATE", "KEY"].join(" ")}${"-".repeat(5)}`;

function fileRecord(path: string, lines: string[]): string {
  return (
    `diff --git a/${path} b/${path}\n` +
    "new file mode 100644\n" +
    "--- /dev/null\n" +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${lines.length} @@\n` +
    lines.map((line) => `+${line}\n`).join("")
  );
}

describe("persistedPatchCopy (V4C T8)", () => {
  it("returns the exact diff itself when there is nothing to hide", () => {
    const diff = fileRecord("src/a.ts", ["export const a = 1;"]);
    const copy = persistedPatchCopy(diff, []);
    expect(copy.text).toBe(diff);
    expect(copy.files).toEqual([]);
    expect(copy.unattributedMatches).toBe(0);
  });

  it("hides every match, counts per file without duplicates and keeps the structure", () => {
    const one = fakeKey("a");
    const two = fakeCursorKey("b");
    const diff =
      fileRecord("tests/redact.test.ts", [`const k = "${one}";`, `again ${one} and ${two}`]) +
      fileRecord("src/clean.ts", ["export {};"]) +
      fileRecord("docs/x.md", [`Authorization: Bearer ${one}`]);

    const copy = persistedPatchCopy(diff, []);

    expect(copy.text.startsWith(`${PERSISTED_PATCH_NOTICE}\ndiff --git `)).toBe(true);
    expect(containsSecretLikeToken(copy.text)).toBe(false);
    expect(copy.text).not.toContain(one);
    expect(copy.text).not.toContain(two);
    expect(copy.files).toEqual([
      {
        path: "tests/redact.test.ts",
        matches: 3,
        kinds: ["cursor_api_key", "openai_compatible_api_key"],
      },
      // A bearer-wrapped key is one string, counted once.
      { path: "docs/x.md", matches: 1, kinds: ["openai_compatible_api_key"] },
    ]);
    // The notice is a preamble: parsers still see the same three file records.
    expect(parseUnifiedDiff(copy.text).files.map((file) => file.newPath)).toEqual([
      "tests/redact.test.ts",
      "src/clean.ts",
      "docs/x.md",
    ]);
    expect(() => assertPersistableText("copy", copy.text)).not.toThrow();
  });

  it("is idempotent: a saved copy maps to itself with nothing left to count", () => {
    const diff = fileRecord("LEAK.txt", [fakeKey("c")]);
    const first = persistedPatchCopy(diff, []);
    const second = persistedPatchCopy(first.text, []);
    expect(second.text).toBe(first.text);
    expect(second.files).toEqual([]);
    expect(second.unattributedMatches).toBe(0);
  });

  it("keeps a multiline key block's hunk counts and an applicable saved patch", () => {
    const lines = ["# config", pemLine("BEGIN"), "QUJD", "REVG", pemLine("END"), "done"];
    const diff = fileRecord("config.txt", lines);
    const original = Buffer.from(diff);
    const copy = persistedPatchCopy(diff, []);
    const hunk = copy.text.slice(copy.text.indexOf("@@ -0,0 +1,6 @@\n")).split("\n");
    const added = hunk.slice(1).filter((line) => line.startsWith("+"));
    expect.soft(added).toHaveLength(lines.length);
    expect.soft(added.slice(1, -1)).toEqual(Array(4).fill("+[redacted]"));
    expect
      .soft(copy.files)
      .toEqual([{ path: "config.txt", matches: 1, kinds: ["private_key_block"] }]);
    expect(containsSecretLikeToken(copy.text)).toBe(false);
    expect(Buffer.from(diff).equals(original)).toBe(true);

    const repo = mkdtempSync(join(tmpdir(), "persisted-patch-"));
    try {
      expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
      for (const input of [diff, copy.text]) {
        const check = spawnSync("git", ["apply", "--check", "-"], {
          cwd: repo,
          input,
          encoding: "utf8",
        });
        expect.soft(check.stderr).toBe("");
        expect.soft(check.status).toBe(0);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each(["-", " "])("keeps the %j prefix on every absorbed hunk line", (prefix) => {
    const lines = [pemLine("BEGIN"), "QUJD", "REVG", pemLine("END")];
    const diff =
      "diff --git a/config.txt b/config.txt\n--- a/config.txt\n+++ b/config.txt\n" +
      (prefix === "-" ? "@@ -1,4 +0,0 @@\n" : "@@ -1,4 +1,4 @@\n") +
      lines.map((line) => `${prefix}${line}\n`).join("");
    const copy = persistedPatchCopy(diff, []);
    expect(copy.text.split("\n").slice(-5, -1)).toEqual(Array(4).fill(`${prefix}[redacted]`));
    expect(containsSecretLikeToken(copy.text)).toBe(false);
  });

  /** `git apply --numstat` of a patch: the structure git actually reads. */
  const numstat = (patch: string): string => {
    const run = spawnSync("git", ["apply", "--numstat", "--whitespace=nowarn", "-"], {
      input: patch,
      encoding: "utf8",
    });
    expect.soft(run.stderr).toBe("");
    return run.stdout;
  };
  /** A real `git diff --no-index` between two file versions. */
  const gitDiff = (before: string, after: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "persisted-patch-diff-"));
    try {
      writeFileSync(join(dir, "old.txt"), before);
      writeFileSync(join(dir, "new.txt"), after);
      return spawnSync("git", ["diff", "--no-index", "--", "old.txt", "new.txt"], {
        cwd: dir,
        encoding: "utf8",
      }).stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it.each([
    [
      "a block that straddles two file records",
      () =>
        fileRecord("a.pem.txt", ["x", pemLine("BEGIN"), "QUJD"]) +
        fileRecord("b.pem.txt", ["REVG", pemLine("END"), "y"]),
    ],
    [
      "an old file that ends inside the block without a newline",
      () =>
        gitDiff(
          `a\n${pemLine("BEGIN")}\nQUJD`,
          `a\n${pemLine("BEGIN")}\nQUJD\nREVG\n${pemLine("END")}\n`,
        ),
    ],
    [
      "one block changed in two places (two hunks)",
      () => {
        const body = Array.from({ length: 12 }, (_, i) => `QUJD${i}`);
        const changed = body.map((line, i) => (i === 1 || i === 10 ? `${line}x` : line));
        const wrap = (lines: string[]): string =>
          `${[pemLine("BEGIN"), ...lines, pemLine("END")].join("\n")}\n`;
        return gitDiff(wrap(body), wrap(changed));
      },
    ],
    [
      "CRLF lines inside the block",
      () => fileRecord("crlf.txt", [`${pemLine("BEGIN")}\r`, "QUJD\r", `${pemLine("END")}\r`]),
    ],
  ])("keeps every file record and hunk for %s", (_name, build) => {
    const diff = build();
    const copy = persistedPatchCopy(diff, []);
    expect(containsSecretLikeToken(copy.text)).toBe(false);
    expect(copy.text).not.toBe(diff);
    expect(numstat(copy.text)).toBe(numstat(diff));
  });

  it("catches a match that straddles two file records and counts it once", () => {
    const diff =
      fileRecord("a.pem.txt", [pemLine("BEGIN"), "QUJD"]) +
      fileRecord("b.pem.txt", ["REVG", pemLine("END")]);

    const copy = persistedPatchCopy(diff, []);

    expect(containsSecretLikeToken(copy.text)).toBe(false);
    expect(copy.files).toEqual([]);
    expect(copy.unattributedMatches).toBe(1);
    expect(
      buildSecretLikeFinding({ copy, binaryPaths: [], mediaWithheld: [], answerMatches: 0 }),
    ).toMatchObject({ total_matches: 1 });
  });

  it("withholds a flagged binary payload, keeps an unflagged one, and stays idempotent", () => {
    const binary = (path: string, payload: string): string =>
      `diff --git a/${path} b/${path}\n` +
      "new file mode 100644\n" +
      "index 0000000..1111111\n" +
      "GIT binary patch\n" +
      "literal 12\n" +
      `${payload}\n` +
      "\n" +
      "literal 0\n" +
      "HcmV?d00001\n" +
      "\n";
    const diff = binary("leak.bin", "TcmZQzU|?imU|`^5") + binary("plain.bin", "ScmZQzU|?imU|`^4");

    const copy = persistedPatchCopy(diff, ["leak.bin"]);

    expect(copy.text).not.toContain("TcmZQzU|?imU|`^5");
    expect(copy.text).toContain("ScmZQzU|?imU|`^4");
    expect(copy.text).toContain("# Claudexor: binary payload withheld from this saved copy");
    // Both records still read as binary changes of the same two paths.
    expect(parseUnifiedDiff(copy.text).files.map((file) => [file.newPath, file.binary])).toEqual([
      ["leak.bin", true],
      ["plain.bin", true],
    ]);
    expect(persistedPatchCopy(copy.text, ["leak.bin"]).text).toBe(copy.text);
  });

  it("redacts a token-shaped path in the disclosure while keeping the count", () => {
    const secret = fakeKey("d");
    const diff = fileRecord(`notes/${secret}.txt`, [`value ${secret}`]);
    const copy = persistedPatchCopy(diff, []);
    expect(JSON.stringify(copy.files)).not.toContain(secret);
    expect(copy.files[0]?.path).toBe("notes/[redacted].txt");
    expect(containsSecretLikeToken(copy.text)).toBe(false);
  });

  it("handles a non-git plain diff with a bare binary record", () => {
    const secret = fakeKey("g");
    const diff =
      "diff -ruN a/note.txt b/note.txt\n" +
      "--- a/note.txt\t2026-01-01\n" +
      "+++ b/note.txt\t2026-01-02\n" +
      "@@ -1 +1 @@\n" +
      "-old\n" +
      `+${secret}\n` +
      "Binary files a/img.bin and b/img.bin differ\n";

    const copy = persistedPatchCopy(diff, ["img.bin"]);

    expect(copy.text).not.toContain(secret);
    expect(copy.text).toContain("Binary files a/img.bin and b/img.bin differ");
    expect(copy.files).toEqual([
      { path: "note.txt", matches: 1, kinds: ["openai_compatible_api_key"] },
    ]);
  });
});

describe("assertPersistableText", () => {
  it("throws only when text still matches after redaction (a redaction bug)", () => {
    expect(() => assertPersistableText("x", "ordinary text")).not.toThrow();
    expect(() => assertPersistableText("final patch copy", `+${fakeKey("z")}`)).toThrow(
      /final patch copy still matches the secret-like policy/,
    );
  });
});

describe("buildSecretLikeFinding", () => {
  it("is absent for a clean capture and totals patch plus answer otherwise", () => {
    const clean = persistedPatchCopy(fileRecord("a.txt", ["safe"]), []);
    expect(
      buildSecretLikeFinding({
        copy: clean,
        binaryPaths: [],
        mediaWithheld: [],
        answerMatches: 0,
      }),
    ).toBeUndefined();
    const copy = persistedPatchCopy(fileRecord("a.txt", [fakeKey("h")]), []);
    expect(
      buildSecretLikeFinding({
        copy,
        binaryPaths: ["b.bin", "b.bin"],
        mediaWithheld: ["z.png", "a.png"],
        answerMatches: 2,
      }),
    ).toEqual({
      files: [{ path: "a.txt", matches: 1, kinds: ["openai_compatible_api_key"] }],
      binary_paths: ["b.bin"],
      media_withheld: ["a.png", "z.png"],
      answer_matches: 2,
      total_matches: 3,
    });
  });
});
