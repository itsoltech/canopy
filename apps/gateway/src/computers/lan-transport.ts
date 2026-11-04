import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { containerBridged } from "../network/addresses.ts";
import type { LanInterface, LanTransportFactory } from "./lan.ts";

const GROUP = "224.0.0.251";
const PORT = 5353;

// Point-to-point VPNs (Tailscale, WireGuard, utun) have no local network to discover on.
const VIRTUAL = /^(lo|tailscale|utun|wg|tun|tap|zt|docker|br-|veth|virbr|vboxnet|vmnet|ham)/i;

export function lanInterfaces(): LanInterface[] {
  const list: LanInterface[] = [];

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;

    for (const a of addresses ?? [])
      if (a.family === "IPv4" && !a.internal && a.netmask !== "255.255.255.255")
        list.push({ address: a.address, netmask: a.netmask });
  }

  return list;
}

/** Why multicast cannot reach the local network here, or nothing. Docker's default bridge network
 * has no multicast to the host's LAN; host networking (or a manual route) is needed there. */
export function lanUnavailable(env: Record<string, string | undefined>): string | undefined {
  const setting = env["CANOPY_LINK_DISCOVERY"]?.toLowerCase();

  if (setting === "off" || setting === "0" || setting === "false") return "Turned off by this server's configuration.";

  if (setting === "on" || setting === "1" || setting === "true") return undefined;

  return containerBridged()
    ? "Running in a container without host networking, so the local network can't be reached. Use host networking or add routes manually."
    : undefined;
}

/** mDNS over IPv4 multicast (RFC 6762), shared with the system's responder through SO_REUSEADDR. */
export const multicastTransport: LanTransportFactory = async (receive) => {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", (packet, info) => receive(packet, { address: info.address, port: info.port }));
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(PORT, "0.0.0.0", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  socket.setMulticastTTL(255);
  socket.setMulticastLoopback(true);
  const joined = new Set<string>();

  const join = () => {
    for (const i of lanInterfaces())
      if (!joined.has(i.address)) {
        try {
          socket.addMembership(GROUP, i.address);
          joined.add(i.address);
        } catch {
          /* interface went away */
        }
      }
  };

  join();
  // Sends are serialized: the outgoing interface is a socket option.
  let queue = Promise.resolve();

  return {
    interfaces: () => {
      join();

      return lanInterfaces();
    },
    send: (packet, via) =>
      (queue = queue.then(
        () =>
          new Promise<void>((resolve) => {
            try {
              if (via) socket.setMulticastInterface(via);
            } catch {
              resolve();

              return;
            }

            socket.send(packet, PORT, GROUP, () => resolve());
          }),
      )),
    close: () =>
      new Promise<void>((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      }),
  };
};
