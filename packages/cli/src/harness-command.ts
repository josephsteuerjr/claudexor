import { flagBool, type ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { subcommandFlagScopeError } from "./command-scope.js";
import { HARNESS_USAGE_ARGS } from "./harness-command-specs.js";
import { harnessInstallCommand } from "./harness-installer.js";
import { harnessInspectCommand, harnessUpdateCommand } from "./harness-maintenance.js";
import { buildRegistry } from "./registry.js";

/**
 * `claudexor harness list [--all]` and `claudexor harness install <id>`.
 * Fakes are test fixtures, not real harnesses; `--all` reveals them. The
 * install verb is the target-aware disclosed installer (harness-installer.ts,
 * issue #89): exact npm pins for claude/codex/opencode, and for the script
 * vendors (cursor, agy) either the human-verified remote PTY path or, under an
 * explicit `--target local --yes`, receipt-bound unattended execution. Nothing
 * executes without disclosure and explicit authorization.
 * Flags are verb-owned (registry `subcommandFlags`): `harness list --yes` or
 * `harness install --all` is a loud exit-2 usage error, never a silently
 * ignored flag (INV-021).
 */
export function harnessCommand(args: ParsedArgs, json: boolean): number {
  const sub = args._[1] ?? "";
  const scopeError = subcommandFlagScopeError("harness", sub, Object.keys(args.flags));
  if (scopeError) return printUsageError(json, scopeError);
  if (args._[1] === "list") {
    const includeFakes = flagBool(args, "all");
    const ids = [...buildRegistry({ includeFakes }).keys()];
    if (json) printJson({ harnesses: ids });
    else ids.forEach((id) => print(id));
    return 0;
  }
  if (args._[1] === "install") {
    return harnessInstallCommand(args, json);
  }
  if (args._[1] === "inspect") return harnessInspectCommand(args, json);
  if (args._[1] === "update") return harnessUpdateCommand(args, json);
  return printUsageError(json, `usage: claudexor harness ${HARNESS_USAGE_ARGS}`);
}
