import { z } from "zod/v3";
import { AccessProfile, AuthPreference, ModeKind, NonBlankString } from "./primitives.js";
import { RunScope } from "./control-run-scope.js";
import { ThreadFolderName, WorkspaceMode } from "./thread.js";

/* Thread request bodies (POST /threads, PATCH /threads/:id). They live beside
 * control.ts the way the apply request does (control-thread-apply.ts), so the
 * thread contract can grow without growing that file (INV-124). */

export const ControlThreadCreateRequest = z
  .object({
    title: z.string().optional().describe("Initial thread title."),
    folder: ThreadFolderName.optional().describe("Initial sidebar folder."),
    scope: RunScope.default({ kind: "none" }),
    mode: ModeKind.optional().describe("Default mode for new turns."),
    workspace: WorkspaceMode.optional().describe(
      "Workspace mode for the thread (in_place or isolated).",
    ),
    authPreference: AuthPreference.optional().describe("Per-thread auth preference override."),
    credentialProfileId: NonBlankString.optional().describe(
      "Sticky credential profile for the thread (INV-135); per-turn selection wins.",
    ),
    primaryHarness: NonBlankString.optional().describe("Sticky primary harness for the thread."),
    /** Sticky eligible pool for the thread; turns inherit it when unset. */
    eligibleHarnesses: z
      .array(NonBlankString)
      .optional()
      .describe("Sticky eligible harness pool; turns inherit it when unset."),
    access: AccessProfile.optional().describe(
      "Sticky write scope for the thread's write turns; omit = the repo trust default.",
    ),
  })
  .strict()
  .describe("Request body for POST /threads.");
export type ControlThreadCreateRequest = z.infer<typeof ControlThreadCreateRequest>;

/** Mutate a thread's title, sidebar folder, open/closed state, or sticky routing
 * (rename, file, archive, switch primary/pool). primaryHarness nullable => clear back to auto. */
export const ControlThreadUpdateRequest = z
  .object({
    title: z.string().optional().describe("New thread title."),
    folder: ThreadFolderName.nullable()
      .optional()
      .describe("New sidebar folder; null moves the thread to ungrouped."),
    state: z.enum(["active", "closed"]).optional().describe("New open/archive state."),
    primaryHarness: NonBlankString.nullable()
      .optional()
      .describe("New sticky primary harness; null clears back to engine routing."),
    credentialProfileId: NonBlankString.nullable()
      .optional()
      .describe("New sticky credential profile; null clears back to engine-default credentials."),
    eligibleHarnesses: z
      .array(NonBlankString)
      .optional()
      .describe("New sticky eligible harness pool."),
    access: AccessProfile.nullable()
      .optional()
      .describe("New sticky write scope; null clears back to the repo trust default."),
  })
  .strict()
  .describe(
    "Request body for PATCH /threads/:id: rename, file into a sidebar folder, archive, or switch sticky routing.",
  );
export type ControlThreadUpdateRequest = z.infer<typeof ControlThreadUpdateRequest>;
