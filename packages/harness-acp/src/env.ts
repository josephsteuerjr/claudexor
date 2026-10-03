// Environment/credential semantics from ouroboros#769; Q00 MIT notice: ../NOTICE.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeBaseEnv, HarnessUnavailableError } from "@claudexor/core";
import { namespacedSecretRefBase, resolveSecret } from "@claudexor/secrets";
import { CredentialProfileStatus, type CredentialProfile } from "@claudexor/schema";
import type { AcpEntry } from "./entry.js";

const BASE_KEYS = new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GH_HOST",
  "COPILOT_GH_HOST",
]);

export function acpToken(
  entry: AcpEntry,
  profile: CredentialProfile | null = null,
  get = resolveSecret,
): string {
  if (
    profile &&
    (profile.harness_id !== entry.id ||
      profile.credential_kind !== "api_key" ||
      namespacedSecretRefBase(profile.secret_ref) !== entry.id)
  ) {
    throw new HarnessUnavailableError(
      `${entry.id} requires an api_key profile with a namespaced ${entry.id}:<profile> secret`,
    );
  }
  const ref = profile?.secret_ref ?? entry.id;
  const token = get(ref);
  if (!token)
    throw new HarnessUnavailableError(
      `${entry.displayName} is not logged in: store the ${ref} secret in Claudexor`,
    );
  return token;
}

export function probeAcpProfile(entry: AcpEntry, profile: CredentialProfile, get = resolveSecret) {
  try {
    acpToken(entry, profile, get);
    return CredentialProfileStatus.parse({
      profile_id: profile.profile_id,
      harness_id: entry.id,
      availability: "available",
      verification: "not_run",
      detail: `secret ${profile.secret_ref} is stored; vendor acceptance is unverified`,
    });
  } catch (error) {
    return CredentialProfileStatus.parse({
      profile_id: profile.profile_id,
      harness_id: entry.id,
      availability: "unavailable",
      verification: "not_run",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A complete patch over the shared spawn base, not a partial denylist. */
export function acpChildEnv(
  entry: AcpEntry,
  home: string,
  token: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string | null> {
  const env: Record<string, string | null> = Object.fromEntries(
    Object.keys(composeBaseEnv("mirror_native")).map((key) => [key, null]),
  );
  for (const [key, value] of Object.entries(composeBaseEnv("mirror_native", source))) {
    if (BASE_KEYS.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    [entry.homeEnv]: join(home, entry.homeDir),
    [entry.tokenEnv]: token,
  };
}

export function prepareAcpEnv(
  entry: AcpEntry,
  token: string,
  overrides: Record<string, string | null | undefined> = {},
) {
  // Unscoped in-place/default probes get a disposable vendor HOME too.
  const base = overrides["HOME"] ? null : mkdtempSync(join(tmpdir(), "claudexor-acp-"));
  const home = overrides["HOME"] || join(base!, "home");
  mkdirSync(join(home, entry.homeDir), { recursive: true, mode: 0o700 });
  const source: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) delete source[key];
    else source[key] = value;
  }
  return {
    env: acpChildEnv(entry, home, token, source),
    dispose: () => {
      if (base) rmSync(base, { recursive: true, force: true });
    },
  };
}
