export interface PublishedProvenanceInput {
  metadata: Record<string, any>;
  attestationDocument: Record<string, any>;
  packageName: string;
  version: string;
  integrity: string;
  sha512Hex: string;
  candidateSha: string;
  repository: string;
  workflowPath: string;
  ref: string;
  /** Already-published skip path: anchor on npm's signed provenance instead
   * of local byte-identity (builds are not byte-reproducible across runs). */
  allowSameSourceRebuild?: boolean;
}

export function validatePublishedProvenance(input: PublishedProvenanceInput): {
  ok: boolean;
  reasons: string[];
};

/** The `npm error` lines of a failed npm command, without npm's debug-log pointer. */
export function npmFailureText(stderr: unknown): string;

export interface NpmSpawnResult {
  status: number | null;
  stderr: string;
}

/** Attempts to move `next` to every published version; returns the packages it left behind. */
export function moveNextChannel(
  packed: ReadonlyArray<{ pkg: { name: string; version: string } }>,
  spawn?: (command: string, args: string[], options: Record<string, unknown>) => NpmSpawnResult,
): string[];
