import { coreRedeliver } from "./core-commands.ts";
import type { GatewayCore } from "./core.ts";

/** A settings commit wakes this gateway's links; heartbeats pick up cancellations committed on another instance. */
export async function redeliverWorkerCleanup(core: GatewayCore) {
  await Promise.all([...core.link.connections.keys()].map((workerId) => coreRedeliver(core, workerId, true)));
}
