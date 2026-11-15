import { AgentTools } from "./agent-tools.ts";
import { coreBroadcastWorkers } from "./core-broadcast.ts";
import type { GatewayCore } from "./core.ts";
import type { GatewayCoreOptions } from "./core-context.ts";

export const createCoreAgentTools = (core: GatewayCore, options: GatewayCoreOptions) =>
  new AgentTools({
    runtime: options.runtime,
    userId: options.userId,
    link: core.link,
    changed: () => coreBroadcastWorkers(core),
  });
