import { createHmac, createPrivateKey, diffieHellman, hkdfSync, X509Certificate } from "node:crypto";
import { BlockList, isIPv4 } from "node:net";
import * as dns from "dns-packet";

/**
 * Local network discovery of computers that are already linked (docs/linked-computers.md, stage 6).
 *
 * Every pair of linked computers derives a discovery key from their pinned node keys (static ECDH,
 * then HKDF). A computer announces itself to each partner under DNS-SD names computed as an HMAC of
 * that key over a 10-minute window: the service type and the instance name are both opaque and change
 * every window, so nobody else on the network can tell the app, the computer or its partners apart
 * from random traffic, or follow it from one window to the next. Records carry no host name, node id,
 * app name or version: only the opaque names, the link port and an address of the announcing
 * interface. A discovered address is only a candidate; the runtime keeps it after a pinned handshake.
 */

export const LAN_WINDOW_MS = 600_000;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const TTL = 120;

export type LanInterface = { address: string; netmask: string };

export type LanSource = { address: string; port: number };

/** The network boundary: real multicast UDP in the gateway, an in-memory network in tests. */
export interface LanTransport {
  /** IPv4 interfaces of this computer on a local network (no loopback, no point-to-point VPN). */
  interfaces(): LanInterface[];
  /** One mDNS packet to the group, sent from `via` (an interface address) when given. */
  send(packet: Buffer, via?: string): Promise<void>;
  close(): Promise<void>;
}

export type LanTransportFactory = (receive: (packet: Buffer, from: LanSource) => void) => Promise<LanTransport>;

const base32 = (bytes: Uint8Array) => {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  return bits ? out + ALPHABET[(value << (5 - bits)) & 31] : out;
};

/** The pairwise discovery key. Both computers compute it from their own private key and the partner's
 * pinned certificate; it is never stored, sent or logged, and changes when either side is re-paired. */
export function discoveryKey(privateKeyPem: string, ownNodeId: string, peerCertificate: string, peerNodeId: string) {
  const shared = diffieHellman({
    privateKey: createPrivateKey(privateKeyPem),
    publicKey: new X509Certificate(peerCertificate).publicKey,
  });

  const salt = [ownNodeId, peerNodeId].sort().join(":");

  return Buffer.from(hkdfSync("sha256", shared, salt, "canopy computer link: lan discovery v1", 32));
}

export type LanNames = { service: string; instance: string; host: string };

/** The names `announcer` uses for its partner in one window. Service labels follow RFC 6335 (15 characters, a letter first). */
export function lanNames(key: Buffer, announcer: string, window: number): LanNames {
  const mac = createHmac("sha256", key).update(`announce|${announcer}|${window}`).digest();
  const instance = base32(mac.subarray(0, 16));
  const service = `_${LETTERS[mac[16]! % 26]}${base32(mac.subarray(17, 26)).slice(0, 14)}._tcp.local`;

  return { service, instance: `${instance}.${service}`, host: `${instance}.local` };
}

export const lanWindow = (now: number) => Math.floor(now / LAN_WINDOW_MS);

const subnets = (interfaces: LanInterface[]) => {
  const list = new BlockList();

  for (const i of interfaces)
    if (isIPv4(i.address))
      list.addSubnet(
        i.address,
        i.netmask.split(".").reduce((n, part) => n + (Number(part) >>> 0).toString(2).replace(/0/g, "").length, 0),
        "ipv4",
      );

  return list;
};

type Partner = { nodeId: string; key: Buffer };

type Options = {
  transport: LanTransportFactory;
  self: () => { nodeId: string; privateKey: string };
  partners: () => Promise<readonly { node_id: string; certificate: string }[]>;
  /** Where this computer's link listener can be reached on the local network, or nothing to announce. */
  listener: () => { port: number; host: string } | undefined;
  /** A partner announced an address in this computer's subnet. Not trusted until a pinned handshake. */
  found: (nodeId: string, address: string) => void;
  now?: () => number;
  queryIntervalMs?: number;
};

export class LanDiscovery {
  #transport: LanTransport | undefined;
  #partners: Partner[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #window = -1;
  #closed = false;
  // Names of the current and adjacent windows: clocks of two computers may differ by a few minutes.
  #expected = new Map<string, { nodeId: string; instance: string }>();
  #own = new Map<string, LanNames>();
  #answered = new Map<string, number>();
  constructor(readonly options: Options) {}
  get transport() {
    return this.#transport;
  }
  #now() {
    return this.options.now?.() ?? Date.now();
  }
  async start() {
    this.#transport = await this.options.transport((packet, from) => {
      try {
        this.#receive(packet, from);
      } catch {
        /* not ours or malformed */
      }
    });
    await this.refresh();
    this.#timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, this.options.queryIntervalMs ?? 60_000);
  }
  /** Partners changed (paired, unlinked): recompute the names, then look for them and announce. */
  async refresh() {
    if (this.#closed) return;
    const self = this.options.self();
    this.#partners = (await this.options.partners()).map((p) => ({
      nodeId: p.node_id,
      key: discoveryKey(self.privateKey, self.nodeId, p.certificate, p.node_id),
    }));
    this.#window = -1;
    await this.tick(true);
  }
  #names() {
    const window = lanWindow(this.#now());

    if (window === this.#window) return false;
    this.#window = window;
    const self = this.options.self().nodeId;
    this.#expected.clear();
    this.#own.clear();
    this.#answered.clear();

    for (const partner of this.#partners)
      for (const w of [window - 1, window, window + 1]) {
        const theirs = lanNames(partner.key, partner.nodeId, w);
        this.#expected.set(theirs.service, { nodeId: partner.nodeId, instance: theirs.instance });
        const ours = lanNames(partner.key, self, w);
        this.#own.set(ours.service, ours);
      }

    return true;
  }
  /** The periodic query for partners. A new window or a changed network (`changed`) also announces this computer. */
  async tick(changed = false) {
    if (this.#closed || !this.#transport) return;

    if (this.#names() || changed) await this.announce();
    await this.query();
  }
  async query() {
    const questions = [...this.#expected.keys()].map((name) => ({ type: "PTR" as const, name }));

    for (const i of this.#transport?.interfaces() ?? []) {
      for (let n = 0; n < questions.length; n += 24)
        await this.#send(dns.encode({ type: "query", id: 0, questions: questions.slice(n, n + 24) }), i.address);
    }
  }
  /** Unsolicited announcement of the current window's names on every interface the listener is reachable on. */
  async announce() {
    const window = lanWindow(this.#now());
    const self = this.options.self().nodeId;
    const names = this.#partners.map((p) => lanNames(p.key, self, window));

    for (let i = 0; i < names.length; i += 8) await this.#answer(names.slice(i, i + 8));
  }
  async #answer(names: LanNames[], to?: LanSource) {
    const listener = this.options.listener();

    if (!listener || !names.length || !this.#transport) return;

    for (const i of this.#transport.interfaces()) {
      if (listener.host !== "0.0.0.0" && listener.host !== "::" && listener.host !== i.address) continue;

      if (to && !subnets([i]).check(to.address, "ipv4")) continue;
      const answers: dns.Answer[] = [];
      const additionals: dns.Answer[] = [];

      for (const n of names) {
        answers.push({ type: "PTR", name: n.service, ttl: TTL, data: n.instance });
        additionals.push(
          {
            type: "SRV",
            name: n.instance,
            ttl: TTL,
            data: { port: listener.port, target: n.host, priority: 0, weight: 0 },
          },
          { type: "TXT", name: n.instance, ttl: TTL, data: "" },
          { type: "A", name: n.host, ttl: TTL, data: i.address },
        );
      }

      await this.#send(
        dns.encode({ type: "response", id: 0, flags: dns.AUTHORITATIVE_ANSWER, answers, additionals }),
        i.address,
      );
    }
  }
  async #send(packet: Buffer, via?: string) {
    await this.#transport?.send(packet, via).catch(() => {});
  }
  #receive(packet: Buffer, from: LanSource) {
    if (this.#closed || !this.#transport || packet.length > 9000) return;
    this.#names();
    const message = dns.decode(packet);

    if (message.type === "query") {
      const asked = new Map<string, LanNames>();

      for (const q of message.questions ?? []) {
        const own = this.#own.get(q.name.toLowerCase());

        // At most one answer per name and second (RFC 6762), so queries cannot turn this computer into an amplifier.
        if (
          !own ||
          (q.type !== "PTR" && String(q.type) !== "ANY") ||
          (this.#answered.get(own.service) ?? 0) > Date.now() - 1000
        )
          continue;
        this.#answered.set(own.service, Date.now());
        asked.set(own.service, own);
      }

      if (asked.size) void this.#answer([...asked.values()], from);

      return;
    }

    const records = [...(message.answers ?? []), ...(message.additionals ?? [])];
    const local = subnets(this.#transport.interfaces());

    for (const ptr of records) {
      if (ptr.type !== "PTR") continue;
      const expected = this.#expected.get(ptr.name.toLowerCase());

      if (!expected || String(ptr.data).toLowerCase() !== expected.instance) continue;
      const srv = records.find((r) => r.type === "SRV" && r.name.toLowerCase() === expected.instance);

      if (srv?.type !== "SRV") continue;
      const { port, target } = srv.data;

      if (!port || port > 65535) continue;

      for (const a of records) {
        if (a.type !== "A" || a.name.toLowerCase() !== target.toLowerCase() || !isIPv4(a.data)) continue;

        // Only an address in a subnet of this computer: never a path to elsewhere on the internet.
        if (local.check(a.data, "ipv4")) this.options.found(expected.nodeId, `https://${a.data}:${port}`);
      }
    }
  }
  async close() {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#transport?.close();
    this.#transport = undefined;
  }
}
