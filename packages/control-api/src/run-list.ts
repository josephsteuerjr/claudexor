/**
 * GET /v2/runs pagination + cache-bounding helpers (QA-052).
 *
 * The route used to map EVERY retained daemon record on every call, silently
 * ignore `limit`/`state`/`cursor`, and clear its whole summary cache past a
 * guard. This module owns the honest, bounded server half:
 *   - a strict typed query (limit / state / opaque keyset cursor);
 *   - deterministic newest-first `(createdAt desc, id desc)` ordering;
 *   - keyset paging that survives concurrent inserts/prunes (walks the set once,
 *     no duplicates or omissions), so projection work is bounded by page size
 *     rather than total retained records;
 *   - an LRU-bounded map primitive so the summary cache evicts its oldest entry
 *     instead of a wholesale clear-and-rehydrate thrash.
 */
import { ControlRunState } from "@claudexor/schema";
import { assertOnlyQueryParams, singleQuery } from "./query.js";

import { decodeRunCursor, type RunListQuery } from "@claudexor/schema";
export {
  orderRunRecords,
  indexAfterCursor,
  encodeRunCursor,
  decodeRunCursor,
  selectRunListPage,
} from "@claudexor/schema";
export type { RunListRecord, RunListQuery } from "@claudexor/schema";

/** Default page size when the caller sends no `limit` — newest-first, so the
 * default page always contains every active (queued/running) run a thread-first
 * client needs to discover without downloading all terminal history. */
const RUN_LIST_DEFAULT_LIMIT = 200;
/** Hard cap on an explicit `limit`; a larger request is a typed 400, never a
 * silently honored unbounded read. */
const RUN_LIST_MAX_LIMIT = 1_000;

function invalidRunListQuery(
  message: string,
  code: "invalid_run_list_query" | "invalid_run_list_cursor",
): Error & { status: number; code: string; requiredActions: string[] } {
  return Object.assign(new Error(message), {
    status: 400,
    code,
    requiredActions:
      code === "invalid_run_list_cursor" ? ["resnapshot"] : ["retry_with_valid_query"],
  });
}

/**
 * Parse + validate the GET /v2/runs query. Unknown params are refused (strict
 * doctrine, matching sibling routes that call `assertOnlyQueryParams`); a typoed
 * `limit`, a foreign `state`, or a malformed `cursor` fails loudly with a typed
 * 400 instead of being silently ignored.
 */
export function parseRunListQuery(url: URL): RunListQuery {
  assertOnlyQueryParams(url, ["limit", "state", "cursor"]);

  let limit = RUN_LIST_DEFAULT_LIMIT;
  const limitRaw = singleQuery(url, "limit");
  if (limitRaw !== undefined) {
    if (!/^[1-9][0-9]*$/.test(limitRaw)) {
      throw invalidRunListQuery("limit must be a positive integer", "invalid_run_list_query");
    }
    const value = Number(limitRaw);
    if (!Number.isSafeInteger(value) || value > RUN_LIST_MAX_LIMIT) {
      throw invalidRunListQuery(
        `limit must be between 1 and ${RUN_LIST_MAX_LIMIT}`,
        "invalid_run_list_query",
      );
    }
    limit = value;
  }

  let state: ControlRunState | null = null;
  const stateRaw = singleQuery(url, "state");
  if (stateRaw !== undefined) {
    const parsed = ControlRunState.safeParse(stateRaw);
    if (!parsed.success) {
      throw invalidRunListQuery(
        `state must be one of: ${ControlRunState.options.join(", ")}`,
        "invalid_run_list_query",
      );
    }
    state = parsed.data;
  }

  const cursorRaw = singleQuery(url, "cursor");
  const cursor = cursorRaw === undefined ? null : decodeRunCursor(cursorRaw);

  return { limit, state, cursor };
}

/** Move an existing key to the most-recently-used position and read it. */
export function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}

/**
 * Insert/refresh `key` at the MRU position, then evict least-recently-used keys
 * until the map is within `cap`. Replaces the old wholesale `.clear()` guard:
 * one stale entry drops at a time, so a large retained set never triggers a
 * full-cache rehydration wave.
 */
export function lruSet<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
