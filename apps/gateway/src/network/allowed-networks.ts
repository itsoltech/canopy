import { isIP } from "node:net";
import type { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { Code, ConnectError } from "@connectrpc/connect";
import { classify, isTailnetAddress, NETWORK_KINDS, type NetworkKind } from "./addresses.ts";

export function selectedNetworks(values: string[]): NetworkKind[] {
  const kinds = NETWORK_KINDS.filter((kind) => values.includes(kind));

  if (!kinds.length || values.some((kind) => !kinds.some((known) => known === kind)))
    throw new ConnectError("Select at least one supported network.", Code.InvalidArgument);

  return kinds;
}

export function allowsAllNetworks(allowed: readonly NetworkKind[]) {
  return NETWORK_KINDS.every((kind) => allowed.includes(kind));
}

/** Node exposes IPv4 sockets on a dual-stack listener as IPv4-mapped IPv6. */
export function normalizeIp(address = "") {
  const host = address.split("%")[0] ?? "";

  if (isIP(host) !== 6) return host;

  const normalized = new URL(`http://[${host}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);

  return mapped
    ? mapped
        .slice(1)
        .flatMap((hextet) => {
          const part = Number.parseInt(hextet, 16);

          return [part >>> 8, part & 255];
        })
        .join(".")
    : normalized;
}

export function connectionDestinations(interfaces = networkInterfaces(), tailnet: readonly string[] = []) {
  const kinds = new Map<string, NetworkKind[]>();
  const tailnetAddresses = new Set(tailnet.map(normalizeIp));

  for (const [name, entries] of Object.entries(interfaces))
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const host = normalizeIp(entry.address);
      const kind = tailnetAddresses.has(host) && isTailnetAddress(host) ? "tailscale" : classify(host, name);

      if (kind) kinds.set(host, [...new Set([...(kinds.get(host) ?? []), kind])]);
    }

  return kinds;
}

/** Attribute forwarded connections by the peer IP the operating system sees after NAT. */
function connectionNetwork(local: readonly NetworkKind[], peer: string): NetworkKind | undefined {
  if (local.length !== 1) return undefined;

  const kind = local[0];

  if (kind === "tailscale") return isTailnetAddress(peer) ? kind : undefined;

  if (kind === "lan") return classify(peer, "");

  return kind;
}

export function acceptsNetwork(
  allowed: readonly NetworkKind[],
  destinations: ReadonlyMap<string, readonly NetworkKind[]>,
  socket: Pick<Socket, "localAddress" | "remoteAddress">,
) {
  if (allowsAllNetworks(allowed)) return true;

  const peer = normalizeIp(socket.remoteAddress);

  if (!peer) return false;

  const kind = connectionNetwork(destinations.get(normalizeIp(socket.localAddress)) ?? [], peer);

  return kind !== undefined && allowed.includes(kind);
}
