import { Code, ConnectError } from "@connectrpc/connect";
import { type GatewayCore } from "../core/core.ts";
import { requireDesktopRole } from "../role.ts";

export function computers(core: GatewayCore) {
  requireDesktopRole(core.role);

  if (!core.computers) throw new ConnectError("Linked computers are not initialized", Code.FailedPrecondition);

  return core.computers;
}

export function moves(core: GatewayCore) {
  const value = computers(core).moves;

  if (!value)
    throw new ConnectError("Moving to linked computers is not available on this computer", Code.FailedPrecondition);

  return value;
}
