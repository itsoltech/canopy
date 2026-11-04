import type { ui } from "@canopy/contracts";
import type { IconName } from "#lib/shared/ui/icons.ts";
import type { Tone } from "#lib/shared/ui/tone.ts";

/** How a phone or computer reaches an address (docs/network-access.md). */
export const ADDRESS_KINDS = new Map<string, { label: string; tone: Tone; icon?: IconName }>([
  ["lan", { label: "Local network", tone: "sky", icon: "signal" }],
  ["tailscale", { label: "Tailscale", tone: "violet" }],
  ["vpn", { label: "VPN", tone: "violet" }],
  ["public", { label: "Public", tone: "amber", icon: "globe-alt" }],
  ["hostname", { label: "Added by you", tone: "neutral" }],
]);

export const addressKind = (kind: string) => ADDRESS_KINDS.get(kind) ?? { label: kind, tone: "neutral" as const };

/** "192.168.1.20, 100.101.2.3 (Tailscale) and 1 more": the hosts only, ports are the same. */
export function reachableAt(status: ui.NetworkAccess, shown = 2) {
  const hosts = status.addresses.map((a) =>
    a.kind === "tailscale" || a.kind === "vpn" ? `${a.host} (${addressKind(a.kind).label})` : a.host,
  );

  const more = hosts.length - shown;

  return more > 0 ? `${hosts.slice(0, shown).join(", ")} and ${more} more` : hosts.join(", ");
}

/** One sentence for the state: what works now, or what to do. */
export function networkSummary(status: ui.NetworkAccess) {
  if (status.state === "error") return status.error;

  if (status.state !== "on") return "Phones and other computers can't connect to this computer yet.";

  return status.addresses.length
    ? `Reachable at ${reachableAt(status)}.`
    : "On, but this computer isn't connected to a network right now.";
}
