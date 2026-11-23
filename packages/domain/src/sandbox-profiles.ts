import { create } from "@bufbuild/protobuf";
import {
  SandboxProfileBindingSchema,
  type SandboxProfile,
  type SandboxProfileBinding,
  type SandboxSupport,
} from "@canopy/contracts";

import { normalizeSandboxProfile } from "./sandbox-profile-validation.ts";

export { normalizeSandboxProfile };

export const SANDBOX_PROFILES_CAPABILITY = "sandbox_profiles_v1";

export function sandboxProfileIdentity(profile: SandboxProfile): string {
  return JSON.stringify([profile.id, profile.name, profile.allowedDomains]);
}

/** Stable even when the client submitted differently ordered or mixed-case domains. */
export function sandboxBinding(input: SandboxProfile): SandboxProfileBinding {
  const profile = normalizeSandboxProfile(input);
  const digest = Bun.CryptoHasher.hash("sha256", sandboxProfileIdentity(profile), "hex");

  return create(SandboxProfileBindingSchema, { profile, digest });
}

export function sandboxSupportProblem(
  support: SandboxSupport | undefined,
  binding: SandboxProfileBinding,
): string | undefined {
  if (!binding.profile) return "This sandbox profile has no policy.";

  if (!support) return "This worker has not verified custom sandbox profile support for this harness.";

  return binding.profile.allowedDomains.length
    ? support.domains
      ? undefined
      : support.domainsReason || "This harness cannot enforce a domain allowlist on this worker."
    : support.offline
      ? undefined
      : support.offlineReason || "This harness cannot enforce an offline sandbox on this worker.";
}
