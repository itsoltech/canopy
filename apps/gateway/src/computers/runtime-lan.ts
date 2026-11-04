import { LAN_ROUTES } from "@canopy/domain/computers";

import { LanDiscovery } from "./lan.ts";

import { computersTick } from "./runtime-connection.ts";
import { computersState, WILDCARD } from "./runtime-context.ts";
import { computersEmit } from "./runtime-mirrors.ts";
import type { LinkedComputers } from "./runtime.ts";
import { discoverCertificate } from "./transport.ts";

// ------------------------------------------------------------------ stage 6: routes and LAN discovery

/** Addresses sent to partners: where network access reaches this computer now (detected addresses
 * and added hostnames). A change is announced over the link. */
export function computersAdvertise(hostContext: LinkedComputers) {
  const network = hostContext.options.network;
  const port = network.port;
  const interfaces = hostContext[computersState].lan?.transport?.interfaces() ?? [];
  const next = network.origins().slice(0, 16);

  // A new network or listener: announce on the local network at once, not at the next window.
  const key = `${port ?? ""}|${interfaces.map((i) => i.address).join()}`;

  if (key !== hostContext[computersState].network) {
    hostContext[computersState].network = key;
    void hostContext[computersState].lan?.tick(true).catch(() => {});
  }

  if (next.join() === hostContext[computersState].advertised.join()) return;
  hostContext[computersState].advertised = next;

  for (const set of hostContext[computersState].active.values())
    for (const c of set) {
      if (c.ready && c.protocol && c.capabilities?.has(LAN_ROUTES))
        c.send({ body: { case: "routes", value: { addresses: next } } });
    }
}

export async function computersDiscovery(hostContext: LinkedComputers) {
  const enabled = Boolean(
    hostContext.options.discovery &&
    !hostContext.options.discovery.unavailable &&
    hostContext[computersState].identity.lan_discovery &&
    !hostContext[computersState].stopped,
  );

  if (!enabled) {
    const lan = hostContext[computersState].lan;
    hostContext[computersState].lan = undefined;
    await lan?.close();
  } else if (!hostContext[computersState].lan) {
    const { transport, now, queryIntervalMs } = hostContext.options.discovery!;

    const lan = new LanDiscovery({
      transport,
      ...(now && { now }),
      ...(queryIntervalMs && { queryIntervalMs }),
      self: () => ({
        nodeId: hostContext[computersState].identity.node_id,
        privateKey: hostContext[computersState].identity.privateKey,
      }),
      partners: () => hostContext.store.peers(),
      listener: () => {
        const { port, host } = hostContext.options.network;

        return port && host ? { port, host } : undefined;
      },
      found: (nodeId, address) => void computersFound(hostContext, nodeId, address).catch(() => {}),
    });

    hostContext[computersState].lan = lan;

    try {
      await lan.start();
      hostContext[computersState].lanError = "";
    } catch {
      hostContext[computersState].lan = undefined;
      await lan.close();
      hostContext[computersState].lanError =
        "Could not open the local network discovery socket (UDP 5353). Add routes manually.";
    }
  }

  computersAdvertise(hostContext);
}

export function computersLanState(hostContext: LinkedComputers) {
  if (!hostContext[computersState].identity.lan_discovery) return { state: "off", note: "" };

  const unavailable = !hostContext.options.discovery
    ? "Local network discovery isn't available on this gateway."
    : hostContext.options.discovery.unavailable || hostContext[computersState].lanError;

  if (unavailable || !hostContext[computersState].lan)
    return { state: "unavailable", note: unavailable || "Starting…" };
  const host = hostContext.options.network.host;

  const reachable =
    host &&
    (WILDCARD.has(host) || hostContext[computersState].lan.transport?.interfaces().some((i) => i.address === host));

  return {
    state: "active",
    note: reachable
      ? ""
      : host
        ? "Network access isn't on a local network interface, so this computer only looks for its linked computers."
        : "This computer looks for its linked computers. Turn on network access so they can find it too.",
  };
}

/** A partner announced itself on the local network. Trust never comes from the network: the address
 * is kept only after the normal pinned handshake proves it reaches the partner's own key. */
export async function computersFound(hostContext: LinkedComputers, nodeId: string, address: string) {
  if (
    hostContext[computersState].stopped ||
    hostContext[computersState].paused ||
    !hostContext[computersState].identity.lan_discovery
  )
    return;
  const now = Date.now();
  const key = `${nodeId} ${address}`;

  // Rate limits, checked and taken before any await so that a burst of answers makes one test:
  // one test per address and interval, and at most 20 tests a minute in total.
  if (
    (hostContext[computersState].tested.get(key) ?? 0) >
    now - (hostContext.options.discovery?.testIntervalMs ?? 60_000)
  )
    return;

  if (now - hostContext[computersState].testBudget.start > 60_000)
    hostContext[computersState].testBudget = { start: now, count: 0 };

  if (hostContext[computersState].testBudget.count >= 20) return;
  hostContext[computersState].tested.delete(key);
  hostContext[computersState].tested.set(key, now);

  if (hostContext[computersState].tested.size > 256)
    hostContext[computersState].tested.delete(hostContext[computersState].tested.keys().next().value!);
  const budget = hostContext[computersState].testBudget;
  budget.count++;
  // A route that worked within ten minutes needs no new test (and gives its budget back).
  const known = (await hostContext[computersState].routes.list(nodeId)).find((r) => r.address === address);

  if (known?.last_success && new Date(known.last_success).getTime() > now - 600_000) {
    budget.count--;

    return;
  }

  const peer = await hostContext.store.peer(nodeId);

  if (!peer) return;
  const started = performance.now();

  try {
    await discoverCertificate(address, peer.fingerprint, hostContext[computersState].identity);
  } catch {
    if (known) await hostContext[computersState].routes.failure(nodeId, address);

    return;
  }

  await hostContext[computersState].routes.add(nodeId, [address], "lan");
  await hostContext[computersState].routes.success(nodeId, address, performance.now() - started);
  computersEmit(hostContext, nodeId);

  if (!hostContext[computersState].active.get(nodeId)?.size) {
    hostContext[computersState].retry.delete(nodeId);
    void computersTick(hostContext).catch(() => {});
  }
}
