import { PermissionMode, Provider, type UpdateTurnPermissions } from "@canopy/contracts";
import { Context, Effect } from "effect";
import { Journal } from "../journal/index.ts";
import { ClaudeThreads } from "../providers/claude/threads.ts";
import { validLivePermissionMode } from "../providers/claude/live-permissions.ts";
import type { HostContext } from "./host-context.ts";
import { CommandError, type CommandOutput } from "./host-types.ts";

export async function updateTurnPermissions(ctx: HostContext, request: UpdateTurnPermissions): Promise<CommandOutput> {
  const { threadId, turnId, permissionMode } = request;

  if (!validLivePermissionMode(permissionMode))
    throw new CommandError("INVALID_PERMISSION_MODE", "Choose a permission mode", true);

  if (permissionMode === PermissionMode.FULL_ACCESS && ctx.state.options.fullAccess === false)
    throw new CommandError("FULL_ACCESS_DISABLED", "Full access is turned off on this computer's worker", true);

  const current = () =>
    !!threadId &&
    !!turnId &&
    ctx.state.running.has(`${threadId}/${turnId}`) &&
    !ctx.state.closedThreads.has(threadId) &&
    !ctx.state.rewindingThreads.has(threadId) &&
    !ctx.state.shuttingDown &&
    !ctx.state.closing &&
    !ctx.state.options.runtime.runSync(Journal.use((j) => j.wasInterrupted(threadId, turnId)));

  if (!current()) throw new CommandError("TURN_NOT_RUNNING", "the turn is not running on this worker", true);

  const claude = [...ctx.state.claude].find(([, handle]) =>
    Context.get(handle.context, ClaudeThreads).running(threadId),
  );

  if (!claude || ctx.state.threadProviders.get(threadId) !== Provider.CLAUDE)
    throw new CommandError("PERMISSION_UPDATE_UNSUPPORTED", "Live permission changes require a Claude turn", true);

  await ctx.ops.runClaude(
    (threads) =>
      threads
        .updateTurnPermissions(threadId, turnId, permissionMode, current)
        .pipe(
          Effect.catchTag("PermissionUpdateError", (error) =>
            Effect.die(new CommandError(error.code, error.message, true)),
          ),
        ),
    claude[0],
    true,
  );

  return {};
}
