/**
 * What the daemon hands a run about the `continueFrom` chain (RunInput
 * `continuation`): every daemon-owned run may keep its stopped isolated work
 * for continuation (only the daemon admits a successor or discards a kept
 * envelope); a successor additionally names its predecessor and, when it runs
 * in the predecessor's workspace, adopts the predecessor's retained envelope.
 *
 * Delegate belt children keep the ordinary dispose: their parent integrates
 * their results and starts new children, so a kept child tree would only
 * accumulate. Admission (INTERFACES §1) already proved the predecessor is a
 * terminal run of this daemon; this resolves it from the same records.
 */
import type { ControlRunStartRequest } from "@claudexor/schema";
import type { RunInput } from "@claudexor/orchestrator";
import { retainedEnvelopeInChain } from "@claudexor/workspace";

interface CommandRecords {
  all(): ReadonlyArray<{
    records(): ReadonlyArray<{ runId?: string; runDir?: string; state: string; params: unknown }>;
  }>;
}

type ChainRecord = ReturnType<ReturnType<CommandRecords["all"]>[number]["records"]>[number];

function paramsOf(record: ChainRecord): Record<string, unknown> {
  return record.params && typeof record.params === "object"
    ? (record.params as Record<string, unknown>)
    : {};
}

/** Head first, with cycle protection for malformed historical links. */
function predecessorChain(
  records: readonly ChainRecord[],
  predecessor: ChainRecord,
): ChainRecord[] {
  const chain: ChainRecord[] = [];
  const seen = new Set<string>();
  for (
    let record: ChainRecord | undefined = predecessor;
    record?.runId && !seen.has(record.runId);
  ) {
    seen.add(record.runId);
    chain.push(record);
    const parent: unknown = paramsOf(record)["continueFrom"];
    record = typeof parent === "string" ? records.find((r) => r.runId === parent) : undefined;
  }
  return chain;
}

export function continuationForRun(
  p: ControlRunStartRequest,
  commands: CommandRecords,
): NonNullable<RunInput["continuation"]> {
  const retain = !p.delegatedFromRunId;
  if (!p.continueFrom) return { retain };
  const records = commands.all().flatMap((store) => store.records());
  const predecessor = records.find((record) => record.runId === p.continueFrom);
  if (!predecessor?.runId || !predecessor.runDir) return { retain };
  // An explicit live root or another project runs elsewhere: the kept envelope stays kept.
  const chain = predecessorChain(records, predecessor);
  const sources = chain.flatMap((record) =>
    record.runId && record.runDir
      ? [{ runId: record.runId, runDir: record.runDir, state: record.state }]
      : [],
  );
  const kept = retainedEnvelopeInChain(sources);
  const ownWorkspace =
    p.execution.isolation !== "live" &&
    !p.execution.workspaceRoot &&
    p.scope.kind === "project" &&
    kept?.envelope.repo_root === p.scope.root;
  return {
    retain,
    adopt: ownWorkspace ? kept : null,
    from: {
      runId: predecessor.runId,
      runDir: predecessor.runDir,
      state: predecessor.state,
      workOrder: chain
        .map((record) => paramsOf(record)["prompt"])
        .filter((prompt): prompt is string => typeof prompt === "string" && !!prompt.trim())
        .reverse()
        .map((prompt) => prompt.trim())
        .join("\n\n"),
      ancestors: sources.slice(1),
      preference: p.continueCarrier ?? "auto",
      inheritModel: p.continueModelInherited ?? (p.model === undefined && p.models === undefined),
    },
  };
}
