import { parseUnifiedDiff } from "@claudexor/core";
import { containsSecretLikeToken, redactSecrets, sensitiveResourcePolicy } from "@claudexor/util";

/**
 * Persistence classifier for candidate patches (INV-062, owner decision 05.10
 * "3. C"): agent bytes are never rolled back, discarded or failed for
 * containing secret-like text. The EXACT diff stays in memory, in the changed
 * files and in the private exact patch object; every SAVED copy goes through
 * `persistedPatchCopy`, and the run discloses paths and counts — never a match.
 */

/** First line of a saved patch copy whose content differs from the exact
 * patch. Git and the diff parsers skip any preamble before the first file
 * record, so the notice travels with the copy without changing its structure. */
export const PERSISTED_PATCH_NOTICE =
  "# Claudexor: secret-like strings are replaced with [redacted] in this saved copy. " +
  "The real bytes stay in the candidate's changed files and in Claudexor's private exact patch object; " +
  "a reviewer workspace copy omits files with secret-like content. Apply through Claudexor, never from this copy.";

const BINARY_PAYLOAD_WITHHELD =
  "# Claudexor: binary payload withheld from this saved copy (secret-like bytes)";

export interface SecretLikeFileFinding {
  path: string;
  matches: number;
  kinds: string[];
}

/** Disclosure record written to `attempt.yaml` and `work_product.yaml` meta as
 * `secret_like`. Paths and rule ids only; a matched value never enters it. */
export interface SecretLikeFinding {
  /** Per changed file, counted on the saved copy of that file's diff. */
  files: SecretLikeFileFinding[];
  /** Binary files whose payload is withheld from the saved copy. */
  binary_paths: string[];
  /** Images that were not copied into `produced/`. */
  media_withheld: string[];
  /** Matches hidden in the answer, counted before its first redaction. */
  answer_matches: number;
  total_matches: number;
}

export interface PersistedPatchCopy {
  /** Byte-identical to the exact diff when nothing had to be hidden. */
  text: string;
  files: SecretLikeFileFinding[];
  /** Matches that span file records and belong to no single file. */
  unattributedMatches: number;
}

const FILE_RECORD_START = /^(?:diff .+|Binary files .+ differ)$/gm;

/** A match starts inside a line, but subsequent lines include their diff
 * prefix. Keep those prefixes and line endings so hunk counts remain valid. */
function redactPatchMatch(match: string): string {
  return match
    .split("\n")
    .map(
      (line, index) =>
        `${index > 0 && /^[ +\-]/.test(line) ? line[0] : ""}[redacted]${line.endsWith("\r") ? "\r" : ""}`,
    )
    .join("\n");
}

/**
 * Build the saved copy of an exact candidate diff: withhold the payload of the
 * named binary files, replace every secret-like string, and count per file in
 * the same pass. A copy with nothing to hide is the exact diff itself (no
 * notice, no new fields), so ordinary runs are unchanged. Idempotent.
 */
export function persistedPatchCopy(
  diff: string,
  withheldBinaries: readonly string[],
): PersistedPatchCopy {
  if (diff.startsWith(PERSISTED_PATCH_NOTICE) && !containsSecretLikeToken(diff)) {
    return { text: diff, files: [], unattributedMatches: 0 };
  }
  const withheld = new Set(withheldBinaries);
  const starts = [...diff.matchAll(FILE_RECORD_START)].map((match) => match.index);
  const files = new Map<string, SecretLikeFileFinding>();
  let unattributedMatches = 0;
  const hide = (text: string, path: string | null): string => {
    const decision = sensitiveResourcePolicy.inspectContent(text, "redact", redactPatchMatch);
    if (decision.matches === 0) return text;
    if (path === null) {
      unattributedMatches += decision.matches;
      return decision.text;
    }
    const safePath = redactSecrets(path);
    const entry = files.get(safePath) ?? { path: safePath, matches: 0, kinds: [] };
    entry.matches += decision.matches;
    entry.kinds = [...new Set([...entry.kinds, ...decision.signatures])].sort();
    files.set(safePath, entry);
    return decision.text;
  };
  let body = hide(diff.slice(0, starts[0] ?? diff.length), null);
  for (let index = 0; index < starts.length; index += 1) {
    let record = diff.slice(starts[index], starts[index + 1] ?? diff.length);
    const parsed = parseUnifiedDiff(record).files[0];
    const path = parsed?.newPath ?? parsed?.oldPath ?? null;
    if (path !== null && withheld.has(path)) {
      const payload = record.search(/^GIT binary patch$/m);
      if (payload >= 0) {
        record = `${record.slice(0, payload)}GIT binary patch\n${BINARY_PAYLOAD_WITHHELD}\n`;
      }
    }
    body += hide(record, path);
  }
  // A match may straddle two file records (a key block opened in one file and
  // closed in the next). The whole-text pass is the authority on what a saved
  // copy may contain; per-file passes only attribute counts.
  body = hide(body, null);
  return {
    text: body === diff ? diff : `${PERSISTED_PATCH_NOTICE}\n${body}`,
    files: [...files.values()],
    unattributedMatches,
  };
}

/** Fence on the text that is about to be written. It can only fire on a
 * redaction bug — agent bytes reach a saved file through `persistedPatchCopy`. */
export function assertPersistableText(label: string, text: string): void {
  if (containsSecretLikeToken(text)) {
    throw new Error(`${label} still matches the secret-like policy after redaction; not written`);
  }
}

export function buildSecretLikeFinding(input: {
  copy: PersistedPatchCopy;
  binaryPaths: readonly string[];
  mediaWithheld: readonly string[];
  answerMatches: number;
}): SecretLikeFinding | undefined {
  const clean = (paths: readonly string[]): string[] =>
    [...new Set(paths.map((path) => redactSecrets(path)))].sort();
  const finding: SecretLikeFinding = {
    files: input.copy.files,
    binary_paths: clean(input.binaryPaths),
    media_withheld: clean(input.mediaWithheld),
    answer_matches: input.answerMatches,
    total_matches:
      input.copy.files.reduce((sum, file) => sum + file.matches, 0) +
      input.copy.unattributedMatches +
      input.answerMatches,
  };
  return finding.total_matches > 0 ||
    finding.binary_paths.length > 0 ||
    finding.media_withheld.length > 0
    ? finding
    : undefined;
}

function named(paths: readonly string[]): string {
  const shown = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${shown}, +${paths.length - 5} more` : shown;
}

/** One human line for `final/summary.md`; null when there is nothing to say. */
export function secretLikeSummaryLine(finding: SecretLikeFinding | undefined): string | null {
  if (!finding) return null;
  const parts: string[] = [];
  const inPatch = finding.total_matches - finding.answer_matches;
  if (inPatch > 0) {
    const paths = finding.files.map((file) => file.path);
    parts.push(
      `${inPatch} in ${paths.length} changed file(s)${paths.length > 0 ? ` (${named(paths)})` : ""} — kept in the changed files, hidden in saved copies`,
    );
  }
  if (finding.binary_paths.length > 0) {
    parts.push(
      `${finding.binary_paths.length} binary payload(s) withheld from the saved patch (${named(finding.binary_paths)})`,
    );
  }
  if (finding.answer_matches > 0) parts.push(`${finding.answer_matches} hidden in the answer`);
  if (finding.media_withheld.length > 0) {
    parts.push(
      `${finding.media_withheld.length} image(s) not saved (${named(finding.media_withheld)})`,
    );
  }
  return parts.length > 0 ? `- Secret-like strings: ${parts.join("; ")}` : null;
}
