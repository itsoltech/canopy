import { create, toJson, type MessageInitShape } from "@bufbuild/protobuf";
import { coreNameBranchAfterTurn } from "../worktrees/branch-naming.ts";
import { SHELL_INPUT_CAPABILITY, SHELL_INPUT_TIMEOUT_MS } from "@canopy/domain";
import { STEER_ATTACHMENTS_CAPABILITY } from "@canopy/domain/release/protocol";
import { CommandResultSchema, CommandSchema, type Command, type CommandResult } from "@canopy/contracts";
import { AgentBusStore, GatewayStore, SteerStore } from "../store/index.ts";
import { BotStore } from "../bots/store.ts";
import type { PendingCommand } from "../store/outbox.ts";
import { coreState, HARNESS_ERROR_CODES, SETTLE_TURN_ENDED } from "./core-context.ts";
import { coreEndLostTurns, coreSettle } from "./core-work-loop.ts";
import { fullAccessRefusal } from "./full-access.ts";
import type { GatewayCore } from "./core.ts";
import { coreSteerAnswered } from "./core-messages.ts";
import { coreBroadcastThread, coreBroadcastTurn, coreLog, coreRun } from "./core-broadcast.ts";
import { coreBroadcastGoal, coreGoalAnswered, coreGoals } from "./core-goals.ts";

export async function coreRedeliver(hostContext: GatewayCore, workerId: string): Promise<void> {
  const connection = hostContext.link.connections.get(workerId);
  const commands = await coreRun(hostContext, (s) => s.pendingCommands(workerId));

  // Return after dispatching the first batch so the worker event loop can start immediately.
  // A bounded SQL page amortizes reads; ACKs/disconnects free each 64-command batch.
  const drain = async (page: PendingCommand[]) => {
    while (page.length && connection?.isOpen && hostContext.link.connections.get(workerId) === connection) {
      const after = page.at(-1)!.command.commandId;

      for (let offset = 0; offset < page.length; offset += 64) {
        if (!connection.isOpen || hostContext.link.connections.get(workerId) !== connection) return;
        await Promise.all(
          page
            .slice(offset, offset + 64)
            .map((pending) =>
              pending.expiresAt.getTime() > Date.now()
                ? coreDeliver(hostContext, workerId, pending.command)
                : undefined,
            ),
        );
      }

      if (!connection.isOpen || hostContext.link.connections.get(workerId) !== connection) return;
      page = await coreRun(hostContext, (s) => s.pendingCommands(workerId, after));
    }
  };

  void drain(commands).catch(() => coreLog(hostContext, `outbox redelivery of ${workerId} will retry on reconnect`));
}

// ------------------------------------------------------------------ commands

export async function coreDispatch(
  hostContext: GatewayCore,
  workerId: string,
  command: MessageInitShape<typeof CommandSchema>,
  meta: { threadId?: string; turnId?: string; ttlSeconds: number; steerId?: string },
): Promise<void> {
  const enqueue = GatewayStore.use((s) =>
    s.enqueueCommand({
      workerId,
      command,
      ttlSeconds: meta.ttlSeconds,
      ...(meta.threadId && { threadId: meta.threadId }),
      ...(meta.turnId && { turnId: meta.turnId }),
    }),
  );

  const steerId = meta.steerId;

  const stored = await hostContext[coreState].actions.run(
    steerId ? SteerStore.use((s) => s.whilePending(steerId, enqueue)) : enqueue,
  );

  if (!stored) return;

  if (
    hostContext[coreState].actions.defer(() => {
      void coreDeliver(hostContext, workerId, stored);
    })
  )
    return;

  void coreDeliver(hostContext, workerId, stored);
}

/** Sends a stored command when the worker is online; offline commands wait in the outbox. */
export async function coreDeliver(hostContext: GatewayCore, workerId: string, command: Command): Promise<void> {
  if (hostContext[coreState].actions.defer(() => coreDeliver(hostContext, workerId, command))) return;
  const connection = hostContext.link.connections.get(workerId);

  if (!connection?.isOpen || !command.kind.case) return;

  if (command.kind.case === "runBotTurn" && !connection.hello.capabilities.includes("bot_harness_v1")) return;

  if (
    command.kind.case === "runBotTurn" &&
    (command.kind.value.attachments.length || command.kind.value.historyAttachments.length) &&
    !connection.hello.capabilities.includes(
      [...command.kind.value.attachments, ...command.kind.value.historyAttachments].some((a) => a.kind !== "image")
        ? "bot_files_v1"
        : "bot_images_v1",
    )
  )
    return;

  if (
    command.kind.case === "runBotTurn" &&
    !(await hostContext[coreState].options.runtime.runPromise(
      BotStore.use((s) => s.harnessDispatchable(command.commandId)),
    ))
  ) {
    await coreRun(hostContext, (s) => s.commandDone(command.commandId, false, { errorCode: "TURN_NOT_RUNNING" }));

    return;
  }

  let result: CommandResult | undefined = fullAccessRefusal(connection.hello.capabilities, command);

  try {
    const body = command.kind.value;

    if (
      (command.kind.case === "createThread" || command.kind.case === "startTurn") &&
      "thread" in body &&
      body.thread
    ) {
      const thread = await coreRun(hostContext, (s) => s.thread(body.thread!.threadId));
      body.thread.connectorTools = await hostContext.connectors.tools(thread.owner_user_id, { workerId });
    }

    const shell =
      (command.kind.case === "startTurn" || command.kind.case === "steerTurn") &&
      command.kind.value.input?.shellCommand !== undefined;

    if (
      command.kind.case === "steerTurn" &&
      command.kind.value.input?.attachments.length &&
      !connection.hello.capabilities.includes(STEER_ATTACHMENTS_CAPABILITY)
    )
      result = create(CommandResultSchema, {
        commandId: command.commandId,
        errorCode: "STEER_ATTACHMENTS_UNSUPPORTED",
        errorMessage:
          "This worker cannot steer messages with files yet. The message stays queued. Update the worker to steer files.",
      });

    result ??=
      shell && !connection.hello.capabilities.includes(SHELL_INPUT_CAPABILITY)
        ? create(CommandResultSchema, {
            commandId: command.commandId,
            ok: false,
            errorCode: "SHELL_UNSUPPORTED",
            errorMessage: "This worker cannot run composer shell commands. Update the worker, then send a new message.",
          })
        : await connection.sendCommand(
            command.kind,
            shell ? SHELL_INPUT_TIMEOUT_MS + 60_000 : (hostContext[coreState].options.commandTimeoutMs ?? 60_000),
            command.commandId,
          );
  } catch {
    return; // disconnected or timed out: stays in the outbox, redelivered on reconnect (the worker deduplicates)
  }

  await coreRun(hostContext, (s) => s.commandDone(command.commandId, result.ok, toJson(CommandResultSchema, result)));

  if (command.kind.case === "steerTurn")
    return coreSteerAnswered(hostContext, command.kind.value.threadId, command.kind.value.inputId, result);

  if (command.kind.case === "setGoal")
    return coreGoalAnswered(hostContext, command.kind.value.threadId, command.kind.value.goalId, result);

  if (result.ok) return;
  const reason = result.errorMessage || result.errorCode;

  switch (command.kind.case) {
    case "createThread": {
      const threadId = command.kind.value.thread?.threadId ?? "";
      await coreRun(hostContext, (s) => s.setThreadStatus(threadId, "failed", `${result.errorCode}: ${reason}`));
      await coreBroadcastThread(hostContext, threadId);

      const failed = await hostContext[coreState].options.runtime.runPromise(
        AgentBusStore.use((s) =>
          s.failQueuedTurns(threadId, `the thread could not be created: ${result.errorCode}: ${reason}`),
        ),
      );

      for (const turnId of failed) {
        await coreBroadcastTurn(hostContext, threadId, turnId);
        await hostContext.bus.onTurnFinished(turnId);
      }

      break;
    }

    case "startTurn": {
      const { thread, turnId } = command.kind.value;
      const source = HARNESS_ERROR_CODES.has(result.errorCode) ? "harness" : "platform";
      await coreRun(hostContext, (s) => s.failTurn(turnId, reason, source, result.errorCode));
      await coreBroadcastTurn(hostContext, thread?.threadId ?? "", turnId);
      await coreBroadcastThread(hostContext, thread?.threadId ?? "");
      await coreSettle(hostContext, thread?.threadId ?? "", SETTLE_TURN_ENDED);
      // The request still says what the work is, also when its turn did not start.
      coreNameBranchAfterTurn(hostContext, thread?.threadId ?? "");

      // A Claude /goal turn: the goal shows why it did not start.
      if (await coreGoals(hostContext, (s) => s.turnFailed(turnId, `${result.errorCode}: ${reason}`)))
        await coreBroadcastGoal(hostContext, thread?.threadId ?? "");
      await hostContext.bus.onTurnFinished(turnId);
      break;
    }

    case "interruptTurn": {
      // The turn is not running there (e.g. it died with the previous worker process): it ends here.
      const { threadId, turnId } = command.kind.value;

      if (result.errorCode !== "TURN_NOT_RUNNING" && !/turn is not running/i.test(result.errorMessage)) {
        coreLog(hostContext, `interrupt of ${threadId} failed on ${workerId}: ${reason}`);
        break;
      }

      await coreEndLostTurns(hostContext, {
        workerId,
        reason: "the turn was no longer running on the worker",
        turnIds: [turnId],
      });
      break;
    }

    default:
      coreLog(hostContext, `command ${command.kind.case} failed on ${workerId}: ${reason}`);
  }
}
