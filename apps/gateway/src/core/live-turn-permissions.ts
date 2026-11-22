import { create } from "@bufbuild/protobuf";
import { InteractionKind, ui } from "@canopy/contracts";
import { CLAUDE_LIVE_PERMISSIONS_CAPABILITY } from "@canopy/domain/release/protocol";
import { SqlClient } from "effect/sql";
import { NotFound, toUiTurn } from "../store/index.ts";
import { RequestExpired } from "../store/errors.ts";
import { checkedPermissionMode, coreState, InvalidError, UnavailableError } from "./core-context.ts";
import { coreBroadcastTurn, coreRun } from "./core-broadcast.ts";
import { coreAnswer } from "./core-interactions.ts";
import { coreCheckFullAccess } from "./full-access.ts";
import { threadSandbox } from "../store/thread-sandbox.ts";
import { permissionChanges, permissionsChanged, withTurnPermissionMutation } from "./turn-permission-state.ts";
import type { GatewayCore } from "./core.ts";

/** Resolve only permission decisions for the exact active turn, using the durable answer path. */
export async function allowFullAccessPermission(
  core: GatewayCore,
  interaction: ui.Interaction,
  sandboxedAutomation = false,
): Promise<void> {
  if (interaction.kind !== InteractionKind.PERMISSION || interaction.status !== "pending" || !interaction.turnId)
    return;

  // Ingress must remain free to ingest the journal event awaited by the switching operation.
  if (permissionChanges(core[coreState].options.runtime).has(interaction.threadId)) return;
  await core[coreState].actions.transaction(async () => {
    await core[coreState].actions.run(
      SqlClient.SqlClient.use((sql) => sql`SELECT id FROM threads WHERE id=${interaction.threadId}::uuid FOR UPDATE`),
    );
    const thread = await coreRun(core, (s) => s.thread(interaction.threadId));
    const turn = await coreRun(core, (s) => s.runningTurn(thread.id));

    if (
      thread.owner_user_id !== core[coreState].options.userId ||
      thread.archived_at ||
      thread.rewind_pending_id ||
      turn?.id !== interaction.turnId ||
      (turn.permission_mode !== "FULL_ACCESS" && !(sandboxedAutomation && turn.permission_mode === "FULL_AUTO")) ||
      permissionChanges(core[coreState].options.runtime).has(interaction.threadId)
    )
      return;
    const pending = await coreRun(core, (s) => s.pendingInteractions(thread.id, [interaction.requestId]));

    if (!pending.length) return;

    try {
      await coreAnswer(
        core,
        { userId: thread.owner_user_id },
        create(ui.AnswerInteractionRequestSchema, { requestId: interaction.requestId, allow: true }),
      );
    } catch (error) {
      // Commit the expired outcome and continue settling the remaining live permissions.
      if (!(error instanceof RequestExpired)) throw error;
    }
  });
}

export async function settleTurnPermissions(core: GatewayCore, threadId: string, turnId: string): Promise<void> {
  for (const interaction of await coreRun(core, (s) => s.pendingInteractions(threadId)))
    if (interaction.turnId === turnId) await allowFullAccessPermission(core, interaction);
}

async function acknowledgedTurn(core: GatewayCore, threadId: string, turnId: string, mode: string): Promise<ui.Turn> {
  const deadline = Date.now() + (core[coreState].options.commandTimeoutMs ?? 10_000);

  for (;;) {
    const turn = (await coreRun(core, (s) => s.turnsOf(threadId, [turnId])))[0];

    if (turn?.permission_mode === mode) return toUiTurn(turn);

    if (Date.now() >= deadline)
      throw new UnavailableError(
        "The worker applied the change, but its saved state is still pending. Reconnect to see the current mode.",
      );
    await Bun.sleep(25);
  }
}

async function apply(core: GatewayCore, request: ui.UpdateTurnPermissionsRequest): Promise<ui.Turn> {
  const mode = checkedPermissionMode(request.permissionMode);

  if (!mode) throw new InvalidError("Choose a permission mode for the running turn.");
  const thread = await coreRun(core, (s) => s.thread(request.threadId));

  if (thread.owner_user_id !== core[coreState].options.userId || thread.archived_at)
    throw new NotFound("thread not found");

  if (threadSandbox(thread)) throw new InvalidError("Live permission changes are unavailable with a sandbox profile.");

  if (thread.provider !== "claude" || thread.runtime !== "worker")
    throw new InvalidError("Live permission changes are available only for Claude.");

  if (thread.rewind_pending_id) throw new InvalidError("This thread is rewinding. Wait for it to finish.");
  const turn = await coreRun(core, (s) => s.runningTurn(thread.id));

  if (!turn || turn.id !== request.turnId || turn.rewind_id)
    throw new InvalidError("This turn is no longer running. Choose permissions for the next turn instead.");
  const connection = thread.worker_id ? core.link.connections.get(thread.worker_id) : undefined;

  if (!connection?.isOpen) throw new UnavailableError("This thread's worker is offline. Reconnect it and try again.");

  if (!connection.hello.capabilities.includes(CLAUDE_LIVE_PERMISSIONS_CAPABILITY))
    throw new InvalidError("Update this thread's worker to change permissions during a running Claude turn.");
  coreCheckFullAccess(core, thread.worker_id, request.permissionMode);
  const runtime = core[coreState].options.runtime;
  const gate = Promise.withResolvers<void>();
  const change = { turnId: turn.id, settled: gate.promise };
  permissionChanges(runtime).set(thread.id, change);
  permissionsChanged(runtime);

  let applied: ui.Turn;

  try {
    const result = await connection.sendCommand(
      {
        case: "updateTurnPermissions",
        value: { threadId: thread.id, turnId: turn.id, permissionMode: request.permissionMode },
      },
      core[coreState].options.commandTimeoutMs ?? 60_000,
    );

    if (!result.ok) throw new InvalidError(result.errorMessage || result.errorCode || "The permission change failed.");
    // Ordered journal events own the stored mode, including ACK loss and a turn ending during the switch.
    applied = await acknowledgedTurn(core, thread.id, turn.id, mode);
  } finally {
    if (permissionChanges(runtime).get(thread.id) === change) permissionChanges(runtime).delete(thread.id);
    permissionsChanged(runtime);
    gate.resolve();
    await settleTurnPermissions(core, thread.id, turn.id);
  }

  await coreBroadcastTurn(core, thread.id, turn.id);

  return applied;
}

/** Serialize owner picks without persisting/replaying a live worker command. */
export function updateTurnPermissions(core: GatewayCore, request: ui.UpdateTurnPermissionsRequest): Promise<ui.Turn> {
  return withTurnPermissionMutation(core[coreState].options.runtime, request.threadId, () => apply(core, request));
}
