import { loadConfig } from "@claudexor/config";
import { credentialProfilePolicyState, credentialProfilePolicyProblem } from "@claudexor/core";
import { canonicalCodexProfileHome } from "@claudexor/harness-codex";
import { canonicalProfileConfigDir } from "@claudexor/harness-claude";
import type { AccountTarget, CredentialProfile } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { buildRegistry } from "./registry.js";

/** Management resolves custody, never inference admission. Disabled portable
 * profiles and ordinary default-named registry rows remain exact targets. */
export function accountManagementTarget(
  target: AccountTarget,
  profiles: readonly CredentialProfile[] = loadConfig(noProjectRepoRoot()).global
    .credential_profiles,
) {
  const profile = profiles.find(
    (p) => p.harness_id === target.harness && p.profile_id === target.profile_id,
  );
  if (!profile)
    throw Object.assign(new Error("Account target is not registered"), {
      status: 404,
      code: "credential_profile_not_found",
    });
  const adapter = buildRegistry({ includeFakes: false }).get(target.harness);
  const state = credentialProfilePolicyState({ adapter, registry: profiles });
  if (state.ambiguous) throw credentialProfilePolicyProblem(state, "credential_profile_ambiguous");
  if (state.policy.identity_scope !== "profile" && !profile.enabled)
    throw Object.assign(
      new Error("Disabled shared native identity cannot be independently addressed"),
      { status: 409, code: "account_identity_shared" },
    );
  if (
    profile.credential_kind !== "config_dir_login" ||
    !profile.isolation_locator ||
    !["codex", "claude"].includes(target.harness)
  )
    throw Object.assign(new Error("This account has no native resource management source"), {
      status: 503,
      code: "account_resources_unsupported",
    });
  const locator =
    target.harness === "codex"
      ? canonicalCodexProfileHome(profile.isolation_locator)
      : canonicalProfileConfigDir(profile.isolation_locator);
  return { profile, locator };
}
