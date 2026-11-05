import { remoteServe, sharedHost, uiHandlers } from "../api/index.ts";
import type { GatewayCore } from "../core/core.ts";
import type { NetworkAccess } from "../network/network.ts";
import { LinkedComputers } from "./runtime.ts";
import { serveComputerUpdates } from "../updates/linked.ts";
import type { Options } from "./runtime-context.ts";
import type { ComputerStore } from "./store.ts";

/** Only local-mode desktop gateways construct link services or open discovery sockets. */
export async function startComputerLinks(
  core: GatewayCore,
  store: ComputerStore,
  network: NetworkAccess,
  discovery: Options["discovery"],
) {
  if (core.role !== "desktop") {
    await store.query(
      `UPDATE computer_peers SET status='inactive', status_since=now()
       WHERE owner_user_id=$1::uuid AND status<>'inactive'`,
      [store.owner],
    );

    return;
  }

  const own = uiHandlers(core);
  core.computers = new LinkedComputers({
    store,
    network,
    serve: remoteServe(own, core),
    shared: sharedHost(core, own),
    core,
    updates: (nodeId, method, request) => serveComputerUpdates(core, nodeId, method, request),
    zone: async () => (await core.settings()).user?.timezone,
    ...(discovery && { discovery }),
  });
  await core.computers.start();
}
