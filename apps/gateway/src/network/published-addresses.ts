import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { classify, originOf, type DetectedAddress, type NetworkKind } from "./addresses.ts";
import { normalizeIp } from "./allowed-networks.ts";
import type { NetworkSettings } from "./settings.ts";

export function publishedAddresses(
  port: number,
  { allowedNetworks, hostnames }: NetworkSettings,
  detected: DetectedAddress[],
  destinations: ReadonlyMap<string, readonly NetworkKind[]>,
) {
  const addresses = new Map<string, ui.NetworkAddress>();

  for (const { host, kind, interfaceName } of detected) {
    if (!allowedNetworks.includes(kind)) continue;
    const origin = originOf(host.includes(":") ? `[${host}]` : host, port);

    if (!addresses.has(origin))
      addresses.set(origin, create(ui.NetworkAddressSchema, { origin, host, kind, interfaceName }));
  }

  for (const entry of hostnames) {
    const origin = originOf(entry, port);

    if (addresses.has(origin)) continue;
    const hostname = entry.startsWith("[") ? entry.slice(1, entry.indexOf("]")) : (entry.split(":")[0] ?? "");
    const host = normalizeIp(hostname);

    const kind =
      detected.find((address) => normalizeIp(address.host) === host)?.kind ??
      destinations.get(host)?.[0] ??
      classify(host, "") ??
      (hostname.endsWith(".local") ? "lan" : "public");

    if (allowedNetworks.includes(kind))
      addresses.set(origin, create(ui.NetworkAddressSchema, { origin, host: entry, kind: "hostname" }));
  }

  return [...addresses.values()];
}
