import { create } from "@bufbuild/protobuf";
import { CommandResultSchema, PermissionMode, type Command, type CommandResult } from "@canopy/contracts";
import { InvalidError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";

/**
 * Full access (PERMISSION_MODE_FULL_ACCESS) runs without a sandbox, so it needs a worker that announces it
 * (capability full_access). An older worker would treat mode 5 as an unknown mode; one with full_access
 * turned off in worker.json does not announce it. Both get a readable refusal, never another mode.
 */
export const FULL_ACCESS = "full_access";

export const FULL_ACCESS_REFUSED =
  "Full access is not available on this computer. Its worker is too old or has full access turned off. Update the worker or choose another mode.";

/** The refusal a StartTurn in Full access gets instead of being sent to a worker without the capability. */
export function fullAccessRefusal(capabilities: readonly string[], command: Command): CommandResult | undefined {
  if (command.kind.case !== "startTurn" || capabilities.includes(FULL_ACCESS)) return undefined;
  const { permissionMode, thread } = command.kind.value;

  if ((permissionMode || thread?.permissionMode) !== PermissionMode.FULL_ACCESS) return undefined;

  return create(CommandResultSchema, {
    ok: false,
    errorCode: "FULL_ACCESS_UNSUPPORTED",
    errorMessage: FULL_ACCESS_REFUSED,
  });
}

/** Refuses a request for Full access at once when the thread's worker is online without the capability. */
export function coreCheckFullAccess(hostContext: GatewayCore, workerId: string | null, mode: PermissionMode): void {
  if (mode !== PermissionMode.FULL_ACCESS || !workerId) return;
  const connection = hostContext.link.connections.get(workerId);

  if (connection?.isOpen && !connection.hello.capabilities.includes(FULL_ACCESS))
    throw new InvalidError(FULL_ACCESS_REFUSED);
}

/**
 * User-created forks and side-thread drafts require choosing Full access again. Agent-created children
 * instead use the owner's inheritance policy (store/automated-permissions.ts).
 */
export const inheritedPermissionMode = (mode: PermissionMode): PermissionMode =>
  mode === PermissionMode.FULL_ACCESS ? PermissionMode.FULL_AUTO : mode;
