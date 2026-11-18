import type { GatewayCore } from "./core.ts";
import { redeliverWorkerCleanup } from "./worker-cleanup-delivery.ts";

export async function botModuleChanged(core: GatewayCore, enabled: boolean) {
  if (enabled) await core.bots.tick();
  else await Promise.all([core.bots.abortInterrupted(), redeliverWorkerCleanup(core)]);
}
