import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { DetectedAddress } from "../addresses.ts";
import type { TailscaleSnapshot } from "./status.ts";

/** Detected addresses with the tailnet first while Tailscale is connected: the MagicDNS name, then the
 * tailnet IPv4 addresses, then everything else in its usual order (docs/tailscale.md). */
export function preferTailnet(
  detected: DetectedAddress[],
  tailscale: TailscaleSnapshot | undefined,
): { host: string; kind: DetectedAddress["kind"]; interfaceName: string }[] {
  if (tailscale?.state !== "connected") return detected;

  const tailnet = new Set(tailscale.ipv4);
  const name = tailscale.magicDns && tailscale.dnsName ? [tailscale.dnsName] : [];

  return [
    ...name.map((host) => ({ host, kind: "tailscale" as const, interfaceName: "MagicDNS" })),
    ...tailscale.ipv4.map((host) => ({
      host,
      kind: "tailscale" as const,
      interfaceName: detected.find((a) => a.host === host)?.interfaceName ?? "Tailscale",
    })),
    ...detected.filter((a) => !tailnet.has(a.host)),
  ];
}

/** What Settings shows about this host's Tailscale. */
export function tailscaleMessage(snapshot: TailscaleSnapshot | undefined) {
  return create(ui.TailscaleSchema, {
    state: snapshot?.state ?? "not_installed",
    dnsName: snapshot?.dnsName ?? "",
    ipv4: snapshot?.ipv4 ?? [],
    ipv6: snapshot?.ipv6 ?? [],
    tailnet: snapshot?.tailnet ?? "",
    magicDns: snapshot?.magicDns ?? false,
    httpsCertificates: Boolean(snapshot?.dnsName && snapshot.certDomains.includes(snapshot.dnsName)),
    checkedAtMs: BigInt(snapshot?.checkedAt ?? 0),
  });
}
