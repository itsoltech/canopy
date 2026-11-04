import { Code, ConnectError } from "@connectrpc/connect";
import { type GatewayCore } from "../core/core.ts";

export function computers(core: GatewayCore) {
  if (!core.computers) throw new ConnectError("Linked computers are not initialized", Code.FailedPrecondition);

  return core.computers;
}

export function moves(core: GatewayCore) {
  const value = computers(core).moves;

  if (!value)
    throw new ConnectError("Moving to linked computers is not available on this computer", Code.FailedPrecondition);

  return value;
}

export function shared(core: GatewayCore) {
  const config = computers(core).shared;

  if (!config)
    throw new ConnectError("Shared configuration is not available on this computer", Code.FailedPrecondition);

  return config;
}
