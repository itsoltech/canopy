import type { SandboxProfile } from "@canopy/contracts";

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
