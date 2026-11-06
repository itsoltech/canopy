import type { GatewayCore, GatewayCoreOptions } from "../core/core.ts";

import { agentsState, type Scope } from "./agents-context.ts";

import { agentsBotToolsMethods, type AgentsBotToolsMethods } from "./agents-bot-tools.ts";
import { agentsBusToolsMethods, type AgentsBusToolsMethods } from "./agents-bus-tools.ts";
import { agentsCatalogMethods, type AgentsCatalogMethods } from "./agents-catalog.ts";
import { LinkedAgentsState } from "./agents-context.ts";
import { agentsDeliveriesMethods, type AgentsDeliveriesMethods } from "./agents-deliveries.ts";
import { agentsReceiveMethods, type AgentsReceiveMethods } from "./agents-receive.ts";
import { agentsTransportMethods, type AgentsTransportMethods } from "./agents-transport.ts";

export class LinkedAgents {
  declare query: AgentsTransportMethods["query"];
  declare machine: AgentsTransportMethods["machine"];
  declare call: AgentsTransportMethods["call"];
  declare redirect: AgentsTransportMethods["redirect"];
  declare peer: AgentsTransportMethods["peer"];
  declare sameHome: AgentsTransportMethods["sameHome"];
  declare ui: AgentsTransportMethods["ui"];
  declare snapshot: AgentsTransportMethods["snapshot"];
  declare thread: AgentsTransportMethods["thread"];
  declare exchange: AgentsTransportMethods["exchange"];
  declare exchangeView: AgentsTransportMethods["exchangeView"];
  declare catalog: AgentsCatalogMethods["catalog"];
  declare overview: AgentsCatalogMethods["overview"];
  declare botTool: AgentsBotToolsMethods["botTool"];
  declare extend: AgentsBusToolsMethods["extend"];
  declare tool: AgentsBusToolsMethods["tool"];
  declare send: AgentsBusToolsMethods["send"];
  declare receive: AgentsReceiveMethods["receive"];
  declare deliver: AgentsReceiveMethods["deliver"];
  declare tick: AgentsDeliveriesMethods["tick"];

  readonly [agentsState] = new LinkedAgentsState();

  constructor(
    readonly core: GatewayCore,
    readonly options: GatewayCoreOptions,
    readonly scope: Scope,
  ) {}

  get owner() {
    return this.options.userId;
  }
}

for (const methods of [
  agentsTransportMethods,
  agentsCatalogMethods,
  agentsBotToolsMethods,
  agentsBusToolsMethods,
  agentsReceiveMethods,
  agentsDeliveriesMethods,
]) {
  const descriptors = Object.getOwnPropertyDescriptors(methods);

  for (const descriptor of Object.values(descriptors)) descriptor.enumerable = false;
  Object.defineProperties(LinkedAgents.prototype, descriptors);
}
