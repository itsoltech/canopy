import { create } from "@bufbuild/protobuf";
import { ShellResultSchema, TurnEndSource, TurnOutcome, type UserInput } from "@canopy/contracts";
import { shellInputText } from "@canopy/domain";
import { Journal, type ThreadEventInit } from "../journal/index.ts";
import { killProcessTree } from "@canopy/process-governor";
import type { HostContext } from "./host-context.ts";
import { CommandError } from "./host-types.ts";
import { runShellInput, SHELL_STOPPED_REASON } from "./shell-process.ts";
import { shellProcessIdentity } from "./shell-process-identity.ts";

const emit = async (ctx: HostContext, threadId: string, event: ThreadEventInit) => {
  ctx.ops.publish(await ctx.state.options.runtime.runPromise(Journal.use((j) => j.append(threadId, event))));
};

/** Once per input id, including a steer that later falls back into the queue. */
export async function prepareShellInput(
  ctx: HostContext,
  threadId: string,
  turnId: string,
  input: UserInput,
  commandId: string,
  startTurn: boolean,
): Promise<UserInput> {
  if (input.shellCommand === undefined) return input;

  if (!input.shellCommand.trim() || !input.shellInputId || !input.authorUserId || input.authorAgentId)
    throw new CommandError("INVALID_SHELL_INPUT", "Shell commands need an owner and a nonempty command.", true);
  const cwd = ctx.state.cwds.get(threadId);

  if (!cwd) throw new CommandError("STEER_NOT_RUNNING", "the turn is not running on this worker", true);
  ctx.ops.checkCwd(cwd);
  const runtime = ctx.state.options.runtime;
  const active = ctx.state.shellRuns.get(input.shellInputId);

  if (active && startTurn) {
    active.turnId = turnId;
    active.startTurn = true;
    await emit(ctx, threadId, { turnId, body: { case: "turnStarted", value: {} } });
  }

  let result = active
    ? await active.pending
    : (input.shellResult ?? (await runtime.runPromise(Journal.use((j) => j.shellInput(input.shellInputId)))));

  if (!result) {
    const controller = new AbortController();
    const pending = executeShell(ctx, { threadId, turnId, input, commandId, startTurn, cwd }, controller);
    ctx.state.shellRuns.set(input.shellInputId, { threadId, turnId, startTurn, controller, pending });

    try {
      result = await pending;
    } finally {
      ctx.state.shellRuns.delete(input.shellInputId);
    }
  }

  // Stop/timeout/restart never starts an agent with an incomplete command result.
  if (result.status !== "completed") {
    if (startTurn)
      await emit(ctx, threadId, {
        turnId,
        body: {
          case: "turnFinished",
          value: {
            outcome: result.status === "interrupted" ? TurnOutcome.INTERRUPTED : TurnOutcome.FAILED,
            source:
              result.status === "interrupted"
                ? result.reason === SHELL_STOPPED_REASON
                  ? TurnEndSource.USER
                  : TurnEndSource.SYSTEM
                : TurnEndSource.PLATFORM,
            reason: result.reason,
            errorCode: "SHELL_INTERRUPTED",
          },
        },
      });
    throw new CommandError("SHELL_INTERRUPTED", result.reason, true);
  }

  return { ...input, text: shellInputText(result), mentions: [], shellResult: result };
}

interface ShellDelivery {
  threadId: string;
  turnId: string;
  input: UserInput;
  commandId: string;
  startTurn: boolean;
  cwd: string;
}

async function executeShell(ctx: HostContext, delivery: ShellDelivery, controller: AbortController) {
  const { threadId, turnId, input, commandId, startTurn, cwd } = delivery;
  const runtime = ctx.state.options.runtime;
  const initial = create(ShellResultSchema, { command: input.shellCommand ?? "", cwd, status: "running" });

  const events = await runtime.runPromise(
    Journal.use((j) =>
      j.beginShellInput(
        { inputId: input.shellInputId, threadId, turnId, commandId, result: initial, pid: 0 },
        startTurn,
      ),
    ),
  );

  if (!events)
    throw new CommandError("SHELL_INTERRUPTED", "Command already started. Send a new message to run it again.", true);

  for (const event of events) ctx.ops.publish(event);
  let result;

  try {
    result = await runShellInput(
      initial.command,
      cwd,
      controller.signal,
      (pid) => runtime.runSync(Journal.use((j) => j.shellPid(input.shellInputId, pid))),
      ctx.state.options.shellTimeoutMs,
    );
  } catch {
    result = create(ShellResultSchema, {
      ...initial,
      status: "failed",
      reason: "Command could not start. Send a new message to retry.",
    });
  }

  // The journal's existing secret redactor masks live platform secrets before persistence and delivery.
  const event = await runtime.runPromise(Journal.use((j) => j.finishShellInput(input.shellInputId, result)));
  ctx.ops.publish(event);

  return event.body.case === "shellInputPrepared" && event.body.value.result ? event.body.value.result : result;
}

export async function recoverShellInputs(ctx: HostContext): Promise<void> {
  const runtime = ctx.state.options.runtime;

  for (const input of await runtime.runPromise(Journal.use((j) => j.openShellInputs()))) {
    if (input.pid && input.processIdentity && shellProcessIdentity(input.pid) === input.processIdentity)
      await killProcessTree(input.pid);

    const result = create(ShellResultSchema, {
      ...input.result,
      status: "interrupted",
      reason: "Command interrupted by a worker restart. Send a new message to run it again.",
    });

    ctx.ops.publish(await runtime.runPromise(Journal.use((j) => j.finishShellInput(input.inputId, result))));
  }
}
