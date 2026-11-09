import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { Code, ConnectError } from "@connectrpc/connect";

/** How a phone or another computer reaches an address (shown next to it in Settings). */
export type AddressKind = "lan" | "tailscale" | "vpn" | "public" | "hostname";

export type DetectedAddress = { host: string; kind: Exclude<AddressKind, "hostname">; interfaceName: string };

// Container and VM bridges are internal to this computer: nothing outside can use them.
const BRIDGE =
  /^(docker|br[-\d]|bridge|veth|virbr|vboxnet|vmnet|vmenet|cni|flannel|cali|podman|lxc|lxd|vEthernet|orb|anpi|awdl|llw)/i;

const VIRTUAL_ADAPTER = /VirtualBox|VMware|Hyper-V|Loopback|OrbStack/i;

// Point-to-point VPNs: reachable by the devices in the same VPN.
const VPN = /^(tailscale|utun|wg|tun|tap|zt|ham|ppp|ipsec|nordlynx|proton)/i;

const ORDER: Record<DetectedAddress["kind"], number> = { lan: 0, tailscale: 1, vpn: 2, public: 3 };

function ipv4(host: string) {
  return host.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function inRange(host: string, base: string, bits: number) {
  const size = 2 ** (32 - bits);

  return Math.floor(ipv4(host) / size) === Math.floor(ipv4(base) / size);
}

export function isPrivateIpv4(host: string) {
  return (
    isIP(host) === 4 &&
    (inRange(host, "10.0.0.0", 8) || inRange(host, "172.16.0.0", 12) || inRange(host, "192.168.0.0", 16))
  );
}

export function classify(host: string, interfaceName: string): DetectedAddress["kind"] | undefined {
  if (
    isIP(host) !== 4 ||
    inRange(host, "0.0.0.0", 8) ||
    inRange(host, "127.0.0.0", 8) ||
    inRange(host, "169.254.0.0", 16) ||
    ipv4(host) >= ipv4("224.0.0.0")
  )
    return undefined;

  if (BRIDGE.test(interfaceName) || VIRTUAL_ADAPTER.test(interfaceName)) return undefined;

  // 100.64.0.0/10 is Tailscale's address space (and carrier-grade NAT elsewhere).
  if (inRange(host, "100.64.0.0", 10) && (VPN.test(interfaceName) || /tailscale/i.test(interfaceName)))
    return "tailscale";

  // macOS utun devices also belong to private relays and VM software. Only advertise their tailnet IPs.
  if (/^utun/i.test(interfaceName)) return undefined;

  if (VPN.test(interfaceName)) return "vpn";

  return isPrivateIpv4(host) || inRange(host, "100.64.0.0", 10) ? "lan" : "public";
}

/** A container on Docker's default bridge network sees only its own internal addresses. */
export function containerBridged() {
  const names = Object.keys(networkInterfaces()).filter((n) => n !== "lo");

  return existsSync("/.dockerenv") && names.length > 0 && names.every((n) => /^eth\d+$/.test(n));
}

/** This computer's IPv4 addresses that other devices can use: local network first, then VPNs. */
export function detectAddresses(): DetectedAddress[] {
  if (containerBridged()) return [];

  return advertisedAddresses(networkInterfaces());
}

/** Pure interface filtering, including subnet boundaries from the actual mask, not an assumed /24. */
export function advertisedAddresses(interfaces: ReturnType<typeof networkInterfaces>): DetectedAddress[] {
  const found = new Map<string, DetectedAddress>();

  for (const [interfaceName, addresses] of Object.entries(interfaces))
    for (const a of addresses ?? []) {
      const kind =
        a.internal || a.family !== "IPv4" || subnetEndpoint(a.address, a.netmask)
          ? undefined
          : classify(a.address, interfaceName);

      if (kind && !found.has(a.address)) found.set(a.address, { host: a.address, kind, interfaceName });
    }

  return [...found.values()].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

function subnetEndpoint(host: string, netmask: string) {
  if (isIP(host) !== 4 || isIP(netmask) !== 4) return true;

  const size = 2 ** 32 - ipv4(netmask);

  if (!Number.isInteger(Math.log2(size))) return true;

  // /31 point-to-point links and /32 host routes have no reserved network/broadcast endpoints.
  if (size <= 2) return false;

  const offset = ipv4(host) % size;

  return offset === 0 || offset === size - 1;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A hostname or address entered in Settings: "host" (the listener's port) or "host:port"
 * (a forwarded port). Returns its normalized form or rejects it with the reason. */
export function hostnameEntry(value: string) {
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/i.exec(value.trim().toLowerCase());
  const host = match?.[1] ?? "";
  const port = match?.[2] ? Number(match[2]) : undefined;
  const bracketed = host.startsWith("[") ? host.slice(1, -1) : "";

  const valid =
    host.length <= 253 &&
    (bracketed
      ? isIP(bracketed) === 6
      : isIP(host) === 4 || (host.split(".").every((label) => LABEL.test(label)) && !/^[\d.]+$/.test(host)));

  if (!match || !valid || (port !== undefined && (port < 1 || port > 65535)))
    throw new ConnectError(
      `“${value.trim()}” isn't a hostname or address. Enter a name like laptop.example.ts.net, optionally with :port.`,
      Code.InvalidArgument,
    );

  return port === undefined ? host : `${host}:${port}`;
}

/** The HTTPS origin of an address or hostname entry on the listener's port. */
export function originOf(entry: string, port: number) {
  return /:\d+$/.test(entry) ? `https://${entry}` : `https://${entry}:${port}`;
}
