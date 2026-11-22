import { create } from "@bufbuild/protobuf";
import {
  SandboxProfileBindingSchema,
  type SandboxProfile,
  type SandboxProfileBinding,
  type SandboxSupport,
} from "@canopy/contracts";

export const SANDBOX_PROFILES_CAPABILITY = "sandbox_profiles_v1";

const idFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const hostnameLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function parseDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  const labels = domain.split(".");
  const suffix = labels.at(-1);

  if (
    domain.length > 253 ||
    labels.length < 2 ||
    !labels.every((label) => hostnameLabel.test(label)) ||
    !suffix ||
    !/[a-z]/u.test(suffix) ||
    suffix === "localhost" ||
    !URL.canParse(`http://${domain}`) ||
    new URL(`http://${domain}`).hostname !== domain
  )
    throw new Error("Enter exact domain names without URLs, ports, IP addresses, or wildcards.");

  return domain;
}

export function normalizeSandboxProfile(profile: SandboxProfile): SandboxProfile {
  if (!idFormat.test(profile.id)) throw new Error("Invalid sandbox profile ID.");
  const name = profile.name.trim();

  if (!name || name.length > 64 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name))
    throw new Error("Enter a profile name on one line, up to 64 characters.");

  const allowedDomains = [...new Set(profile.allowedDomains.map(parseDomain))].sort();

  if (allowedDomains.length > 100) throw new Error("A sandbox profile can list up to 100 domains.");

  return { ...profile, name, allowedDomains };
}

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
