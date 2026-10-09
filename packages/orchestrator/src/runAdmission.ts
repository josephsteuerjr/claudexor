import type { AccessProfile, ModeKind } from "@claudexor/schema";
import {
  normalizeUserOutputSchema,
  resolveRunAccess,
  runAccessStrategyViolation,
  runExecutionWorkspaceViolation,
} from "@claudexor/schema";
import { assertMandatoryContext } from "@claudexor/context";
import { noProjectRepoRoot } from "@claudexor/util";
import { assertOutputSchemaCompiles } from "./structuredOutput.js";
import { assertWriteIsolation } from "./write-isolation.js";
import { assertCouncilWidth } from "./council.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

export interface RunAdmissionInput {
  repoRoot: string;
  executionRoot?: string;
  retryOf?: string | null;
  access?: AccessProfile;
  attempts?: number | null;
  untilClean?: boolean;
  tests?: readonly unknown[] | null;
  inPlace?: boolean;
  delegated?: boolean;
  denyPaths?: string[];
  outputSchema?: Record<string, unknown> | null;
  council?: boolean;
  n?: number;
}

export interface RunAdmissionDeps {
  accessDefault: AccessProfile;
  projectProtectedPaths: () => readonly string[];
  mandatoryFiles: () => readonly string[];
  maxCouncilMembers?: number;
}

interface AdmissionViolation {
  code: string;
  message: string;
  retryable: false;
  requiredActions: readonly string[];
}

function throwAdmissionViolation(violation: AdmissionViolation | null): void {
  if (!violation) return;
  throw Object.assign(new Error(violation.message), {
    status: 400,
    code: violation.code,
    retryable: violation.retryable,
    requiredActions: [...violation.requiredActions],
  });
}

/**
 * Pre-announcement engine admission shared by every run strategy.
 *
 * Keep these checks together and ordered: access/strategy coherence and the
 * delegated execution-root backstop run before any filesystem-policy check;
 * output contracts and mandatory project context are then validated before a
 * run directory can be announced.
 */
export function admitRun(
  input: RunAdmissionInput,
  mode: ModeKind,
  deps: RunAdmissionDeps,
): Record<string, unknown> | null | undefined {
  if (input.council) assertCouncilWidth(input.n, deps.maxCouncilMembers);
  const effectiveAccess = resolveRunAccess(
    { mode, access: input.access },
    deps.accessDefault,
  ).effective;
  throwAdmissionViolation(runAccessStrategyViolation(input, effectiveAccess));
  throwAdmissionViolation(
    runExecutionWorkspaceViolation(
      {
        mode,
        retryOf: input.retryOf,
        execution: {
          isolation: input.inPlace === true ? "live" : "envelope",
          delegated: input.delegated === true,
          ...(input.executionRoot === undefined ? {} : { workspaceRoot: input.executionRoot }),
        },
      },
      effectiveAccess,
    ),
  );

  if (effectiveAccess !== "readonly") {
    assertWriteIsolation({
      mode,
      protectedPaths: mode === "agent" ? deps.projectProtectedPaths() : [],
      denyPaths: input.denyPaths,
      inPlace: input.inPlace,
      repoRoot: input.repoRoot,
      executionRoot: input.executionRoot ?? input.repoRoot,
    });
  }

  let outputSchema = input.outputSchema;
  if (outputSchema !== undefined && outputSchema !== null) {
    if (mode !== "agent" && mode !== "ask") {
      throw new Error(
        `outputSchema constrains the final answer and applies to agent/ask runs (got mode=${mode}); drop the schema or switch modes`,
      );
    }
    if (input.untilClean || (input.attempts !== undefined && input.attempts !== null)) {
      throw new Error(
        "outputSchema is not supported with convergence flags (--until-clean/--attempts): convergence delivers a gated patch, not a structured answer; drop the schema or the convergence flags",
      );
    }
    outputSchema = normalizeUserOutputSchema(outputSchema);
    assertOutputSchemaCompiles(outputSchema);
  }

  if (input.repoRoot !== NO_PROJECT_ROOT) {
    assertMandatoryContext(input.executionRoot ?? input.repoRoot, deps.mandatoryFiles());
  }
  return outputSchema;
}
