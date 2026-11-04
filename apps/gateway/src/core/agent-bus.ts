import { busState, type BusHost } from "./agent-bus-context.ts";
import { AgentBusState } from "./agent-bus-context.ts";
import { busDeliveriesMethods, type BusDeliveriesMethods } from "./agent-bus-deliveries.ts";
import { busRequestsMethods, type BusRequestsMethods } from "./agent-bus-requests.ts";

export { type BusHost } from "./agent-bus-context.ts";

export class AgentBus {
  readonly [busState] = new AgentBusState();
  declare handle: BusRequestsMethods["handle"];
  declare onTurnFinished: BusDeliveriesMethods["onTurnFinished"];
  declare deliverNotifications: BusDeliveriesMethods["deliverNotifications"];
  declare deliverAnswers: BusDeliveriesMethods["deliverAnswers"];
  declare onInteraction: BusDeliveriesMethods["onInteraction"];

  constructor(host: BusHost) {
    this[busState].host = host;
  }
}

// Keep class method descriptors and the original receiver while composing the domain operations.
for (const methods of [busRequestsMethods, busDeliveriesMethods]) {
  const descriptors = Object.getOwnPropertyDescriptors(methods);

  for (const descriptor of Object.values(descriptors)) descriptor.enumerable = false;
  Object.defineProperties(AgentBus.prototype, descriptors);
}
