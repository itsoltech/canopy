import { toJson, type MessageInitShape } from "@bufbuild/protobuf";
import { CommandResultSchema, CommandSchema, type Command, type CommandResult } from "@canopy/contracts";
import { AgentBusStore } from "../store/index.ts";
import { coreState, HARNESS_ERROR_CODES, SETTLE_TURN_ENDED } from "./core-context.ts";
import { coreEndLostTurns, coreSettle } from "./core-work-loop.ts";
import type { GatewayCore } from "./core.ts";
import { coreSteerAnswered } from "./core-messages.ts";
import { coreBroadcastThread, coreBroadcastTurn, coreLog, coreRun } from "./core-broadcast.ts";
import { coreBroadcastGoal, coreGoalAnswered, coreGoals } from "./core-goals.ts";

export async function coreRedeliver(hostContext: GatewayCore, workerId: string): Promise<void> {
  const commands = await coreRun(hostContext, (s) => s.pendingCommands(workerId));

  for (const command of commands) void coreDeliver(hostContext, workerId, command);
}

// ------------------------------------------------------------------ commands

export async function coreDispatch(
  hostContext: GatewayCore,
  workerId: string,
  command: MessageInitShape<typeof CommandSchema>,
  meta: { threadId?: string; turnId?: string; ttlSeconds: number },
): Promise<void> {
  const stored = await coreRun(hostContext, (s) =>
    s.enqueueCommand({
      workerId,
      command,
      ttlSeconds: meta.ttlSeconds,
      ...(meta.threadId && { threadId: meta.threadId }),
      ...(meta.turnId && { turnId: meta.turnId }),
    }),
  );

  void coreDeliver(hostContext, workerId, stored);
}

/** Sends a stored command when the worker is online; offline commands wait in the outbox. */
export async function coreDeliver(hostContext: GatewayCore, workerId: string, command: Command): Promise<void> {
  if (hostContext[coreState].actions.defer(() => coreDeliver(hostContext, workerId, command))) return;
  const connection = hostContext.link.connections.get(workerId);

  if (!connection?.isOpen || !command.kind.case) return;
  let result: CommandResult;

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

    result = await connection.sendCommand(
      command.kind,
      hostContext[coreState].options.commandTimeoutMs ?? 60_000,
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
      await coreSettle(hostContext, thread?.threadId ?? "", SETTLE_TURN_ENDED);

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
