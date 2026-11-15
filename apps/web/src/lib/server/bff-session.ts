import { BffSession } from "./bff-state.ts";
import { gateway, onGatewayTargetChange } from "./gateway.ts";

let session: BffSession | undefined;

const stop = onGatewayTargetChange(() => {
  session?.close();
  session = undefined;
});

import.meta.hot?.dispose(() => {
  stop();
  session?.close();
});

export function bffSession() {
  const api = gateway();

  if (!session || session.api !== api) {
    session?.close();
    session = new BffSession(api);
  }

  return session;
}
