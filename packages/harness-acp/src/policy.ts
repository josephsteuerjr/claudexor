// Semantics ported from Róger Valderrama's ouroboros#769. Q00 MIT notice: ../NOTICE.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { AccessProfileIncompatibleError } from "@claudexor/core";
import type { AccessProfile, HarnessRunSpec } from "@claudexor/schema";
import type { AcpEntry } from "./entry.js";

/** Resolve existing ancestors too: an edit of a new file under a symlink is an escape. */
function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // realpath reports ENOENT for a dangling link too. Follow its target
    // before resolving missing ancestors, or a new write could escape cwd.
    try {
      if (lstatSync(path).isSymbolicLink())
        return physicalPath(resolve(dirname(path), readlinkSync(path)));
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(physicalPath(parent), relative(parent, path));
  }
}

function inWorkspace(cwd: string, path: unknown): boolean {
  if (typeof path !== "string" || !path.trim() || path.startsWith("~")) return false;
  try {
    const delta = relative(physicalPath(resolve(cwd)), physicalPath(resolve(cwd, path)));
    return delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
  } catch {
    return false;
  }
}

export const denyPermission = (): RequestPermissionResponse => ({
  outcome: { outcome: "cancelled" },
});

/** Typed kind and path evidence only. An allowed shell is NOT an OS sandbox. */
export function decidePermission(
  access: AccessProfile,
  cwd: string,
  params: RequestPermissionRequest,
): RequestPermissionResponse {
  const call = params.toolCall;
  if (!call || !Array.isArray(params.options)) return denyPermission();
  if (access !== "full") {
    if (access === "inherit_native") return denyPermission();
    const kinds =
      access === "readonly" ? ["read", "search"] : ["read", "search", "edit", "execute"];
    if (!call.kind || !kinds.includes(call.kind)) return denyPermission();
    const raw = call.rawInput ?? {};
    if (typeof raw !== "object" || Array.isArray(raw)) return denyPermission();
    const input = raw as Record<string, unknown>;
    const locations = call.locations ?? [];
    if (!Array.isArray(locations) || locations.some((l) => !l || typeof l !== "object"))
      return denyPermission();
    const paths: unknown[] = locations.map((l) => l.path);
    for (const key of [
      "path",
      "file_path",
      "fileName",
      "cwd",
      "workingDirectory",
      "working_directory",
    ]) {
      if (key in input) paths.push(input[key]);
    }
    const extra = typeof input["paths"] === "string" ? [input["paths"]] : (input["paths"] ?? []);
    if (!Array.isArray(extra)) return denyPermission();
    paths.push(...extra);
    const nonblank = (value: unknown) => typeof value === "string" && value.trim().length > 0;
    if (call.kind === "edit" && paths.length === 0) return denyPermission();
    if (call.kind === "execute" && !nonblank(input["command"])) return denyPermission();
    if (
      (call.kind === "read" || call.kind === "search") &&
      paths.length === 0 &&
      !nonblank(input["pattern"])
    )
      return denyPermission();
    if (!paths.every((path) => inWorkspace(cwd, path))) return denyPermission();
  }
  const kinds = access === "full" ? ["allow_always", "allow_once"] : ["allow_once"];
  for (const kind of kinds) {
    const option = params.options.find(
      (o) => o.kind === kind && typeof o.optionId === "string" && o.optionId.length > 0,
    );
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return denyPermission();
}

export function acpArgs(entry: AcpEntry, spec: HarnessRunSpec): string[] {
  const args = [...entry.flags];
  if (spec.model_hint) args.push("--model", spec.model_hint);
  if (spec.effort_hint) args.push("--effort", spec.effort_hint);
  const { allow, deny } = spec.tool_permission_policy;
  const defaults =
    spec.access === "readonly"
      ? entry.readTools
      : spec.access === "workspace_write"
        ? entry.workspaceTools
        : [];
  const allowed = defaults.length
    ? defaults.filter((t) => (!allow.length || allow.includes(t)) && !deny.includes(t))
    : allow;
  if (defaults.length && !allowed.length)
    throw new AccessProfileIncompatibleError(
      "ACP tool policy leaves no available tools for this access profile",
    );
  if (allowed.length) args.push(`--available-tools=${allowed.join(",")}`);
  if (deny.length) args.push(`--excluded-tools=${deny.join(",")}`);
  return args;
}
