import type { HarnessModelSpec } from "@claudexor/core";
import type { HarnessModel } from "@claudexor/schema";
import { isAgyProfileKeychainUnsafe } from "./keychain.js";
import { AGY_BIN, resolveAgyProfileRoute } from "./profile.js";
import { runAgyPrintCommand } from "./print-command.js";

/** Account-scoped enumeration only. No auth precheck, login, fallback to a
 * sibling account, or model cache: the existing Accounts owner retains display
 * evidence, while dispatch asks for its exact route. An unsuccessful read is
 * the adapter contract's [] (unknown), never a confirmed empty catalog. */
export async function listAgyModels(
  spec: HarnessModelSpec,
  prepareProfileKeychain: (home: string) => void,
): Promise<HarnessModel[]> {
  if (!spec.credentialProfile) return [];
  const route = resolveAgyProfileRoute(spec.credentialProfile, spec.env);
  if ("refusal" in route) return [];
  try {
    try {
      prepareProfileKeychain(route.home);
    } catch (error) {
      if (isAgyProfileKeychainUnsafe(error)) return [];
      // Operational keychain setup errors retain the vendor's file fallback.
    }
    const result = await runAgyPrintCommand(AGY_BIN(), "models", route.env, {
      abortSignal: spec.abortSignal,
    });
    if (result.kind !== "completed" || result.code !== 0 || result.signal !== null) return [];
    return parseAgyModelList(result.stdout);
  } catch {
    return [];
  }
}

/** Recorded `agy models` stdout is headerless TSV: exact id, display label.
 * Reject malformed/partial tables as unknown instead of presenting a silently
 * shortened inventory. Membership is advisory even for a valid table. */
export function parseAgyModelList(stdout: string): HarnessModel[] {
  const rows: HarnessModel[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const columns = line.split("\t");
    if (columns.length !== 2) return [];
    const [id, label] = columns;
    if (!id || /\s/.test(id) || !label?.trim()) return [];
    rows.push({ id, label, context_window: null, routes: ["local_session"], origin: "live" });
  }
  return rows;
}
