/**
 * The `harness` command's surface, kept beside its installable set so ONE
 * array spells that set everywhere it is printed: the registry usage line,
 * the dispatcher's usage error (harness-command.ts) and the installer's own
 * refusal (harness-installer.ts). This module stays value-import-free on
 * purpose — harness-installer.ts reaches command-registry.ts through args.ts,
 * so owning the array there would close a runtime import cycle.
 */
import type { CliCommandSpec } from "./command-registry.js";

/** Vendor CLIs `claudexor harness install` can fetch. harness-installer.ts
 * owns each one's install recipe and its test asserts this list is exhaustive. */
export const INSTALLABLE_HARNESSES = [
  "agy",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "opencode",
] as const;

/** The `harness` argument shape: rendered by `claudexor help` and reprinted by
 * the dispatcher when a verb is unknown. */
export const HARNESS_USAGE_ARGS = `list [--all] | install <${INSTALLABLE_HARNESSES.join("|")}> [--target <local|remote>] [--dry-run] [--yes] | inspect [<id>] [--latest] | update <id> [--vendor-version <exact|latest>] [--yes]`;

export const HARNESS_COMMAND_SPECS: readonly CliCommandSpec[] = [
  {
    id: "harness",
    positionalPatterns: [
      { prefix: ["list"], min: 1, max: 1 },
      { prefix: ["install"], min: 2, max: 2 },
      { prefix: ["inspect"], min: 1, max: 2 },
      { prefix: ["update"], min: 2, max: 2 },
    ],
    usageArgs: HARNESS_USAGE_ARGS,
    summary:
      "List harnesses, install one vendor CLI through the disclosed producer, or inspect/update an installed one",
    flags: ["all", "target", "dry-run", "yes", "latest", "vendor-version", "json"],
    subcommandFlags: {
      list: ["all"],
      install: ["target", "dry-run", "yes"],
      inspect: ["latest"],
      update: ["vendor-version", "yes"],
    },
    mutability: "ops",
    stability: "stable",
  },
];
