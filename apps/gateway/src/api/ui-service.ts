import { ui } from "@canopy/contracts";
import { type ConnectRouter, type ServiceImpl } from "@connectrpc/connect";
import { type GatewayCore } from "../core/core.ts";
import { routed } from "./routed.ts";
import { attachmentsHandlers } from "./ui-attachments.ts";
import { botsHandlers } from "./ui-bots.ts";
import { computersHandlers } from "./ui-computers.ts";
import { connectorsHandlers } from "./ui-connectors.ts";
import { mobileHandlers } from "./ui-mobile.ts";
import { networkHandlers } from "./ui-network.ts";
import { projectsHandlers } from "./ui-projects.ts";
import { providersHandlers } from "./ui-providers.ts";
import { queueHandlers } from "./ui-queue.ts";
import { settingsHandlers } from "./ui-settings.ts";
import { threadsHandlers } from "./ui-threads.ts";
import { workersHandlers } from "./ui-workers.ts";
import { agentEnvironmentHandlers } from "./ui-agent-environment.ts";

export { toConnectError } from "./ui-errors.ts";

export type UiHandlers = ServiceImpl<typeof ui.GatewayService>;

/** GatewayService for the UI (docs/ui-api.md), with threads of linked computers routed to their home (routed.ts). */
export function uiRoutes(core: GatewayCore): (router: ConnectRouter) => void {
  return (router) => router.service(ui.GatewayService, routed(core, uiHandlers(core)));
}

/** This computer's own GatewayService. Thin: validation and state live in the core and the store. */
export function uiHandlers(core: GatewayCore): UiHandlers {
  return {
    ...agentEnvironmentHandlers(core),
    ...computersHandlers(core),
    ...workersHandlers(core),
    ...threadsHandlers(core),
    ...mobileHandlers(core),
    ...networkHandlers(core),
    ...connectorsHandlers(core),
    ...botsHandlers(core),
    ...projectsHandlers(core),
    ...settingsHandlers(core),
    ...providersHandlers(core),
    ...attachmentsHandlers(core),
    ...queueHandlers(core),
  };
}
