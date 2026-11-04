import type { LanInterface, LanSource, LanTransportFactory } from "../../../apps/gateway/src/computers/lan.ts";

type Member = { name: string; interfaces: LanInterface[]; receive: (packet: Buffer, from: LanSource) => void };

/** A local network in memory: multicast delivery to every member (the sender too, like IP_MULTICAST_LOOP).
 * Only the transport is replaced; packets are the real mDNS encoding of the gateway. */
export class MemoryLan {
  readonly members = new Set<Member>();
  readonly sent: { name: string; packet: Buffer }[] = [];
  /** `interfaces` stays mutable: changing it is a computer's address change. */
  transport(name: string, interfaces: LanInterface[]): LanTransportFactory {
    return async (receive) => {
      const member: Member = { name, interfaces, receive };
      this.members.add(member);

      return {
        interfaces: () => [...member.interfaces],
        send: async (packet, via) => {
          this.sent.push({ name, packet });
          this.deliver(packet, via ?? member.interfaces[0]?.address ?? "127.0.0.1");
        },
        close: async () => {
          this.members.delete(member);
        },
      };
    };
  }
  /** A packet from anyone on the network, e.g. a stranger in a café. */
  deliver(packet: Buffer, from: string) {
    for (const member of this.members) queueMicrotask(() => member.receive(packet, { address: from, port: 5353 }));
  }
  from(name: string) {
    return this.sent.filter((s) => s.name === name);
  }
}
