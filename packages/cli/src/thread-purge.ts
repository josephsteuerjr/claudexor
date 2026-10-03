/**
 * The ONE owner of thread byte deletion (owner decision E2): the purge route
 * and the retention pass both call it. The purge is journaled FIRST, so the
 * explicit authority exists before any byte goes, and validation can never
 * fail after user state was removed. Then the thread's daemon-owned
 * directories go: the isolated worktree with its `claudexor/thread-*` branch,
 * and every lane home (INV-034 lifecycle owner (a)).
 *
 * A directory error after the journal commit (ENOTEMPTY, EBUSY, a Windows
 * lock) leaves a purged thread that every listing hides while its directories
 * remain. Calling the owner again journals nothing new (the reducer keeps a
 * purged thread as it is) and deletes what is left; `hasPurgeLeftovers` names
 * exactly the directories this owner deletes, so the retention pass retries a
 * purge until they are gone and never loops on a directory it cannot own.
 */
import type { ProjectPartitions } from "@claudexor/daemon";
import type { Thread } from "@claudexor/schema";
import {
  purgeThreadLanes,
  purgeThreadWorktree,
  threadLanesExist,
  threadWorktreeDirExists,
} from "@claudexor/workspace";

export function threadPurgeOwner(
  threads: Pick<ProjectPartitions, "getThread" | "purgeThread">,
  noProjectRoot: string,
) {
  const isolatedRoot = (thread: Thread): string | null =>
    thread.repo && thread.workspace.mode === "isolated" ? thread.repo.root : null;
  const lanesRoot = (thread: Thread): string => thread.repo?.root ?? noProjectRoot;
  return {
    purgeThread: async (id: string) => {
      const thread = threads.getThread(id);
      if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
      const purged = threads.purgeThread(id);
      const worktreeRoot = isolatedRoot(thread);
      if (worktreeRoot) await purgeThreadWorktree(worktreeRoot, id);
      // Lane homes exist regardless of workspace mode (in_place threads have
      // them too), so they go for EVERY purged thread.
      purgeThreadLanes(lanesRoot(thread), id);
      return purged;
    },
    /** Whether a directory this owner deletes for the thread is still on disk. */
    hasPurgeLeftovers: (thread: Thread): boolean => {
      const worktreeRoot = isolatedRoot(thread);
      return (
        (worktreeRoot !== null && threadWorktreeDirExists(worktreeRoot, thread.id)) ||
        threadLanesExist(lanesRoot(thread), thread.id)
      );
    },
  };
}
