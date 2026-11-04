import { create } from "@bufbuild/protobuf";
import { GoalDirective, ItemStatus, ui, type CommandResult } from "@canopy/contracts";
import { Effect } from "effect";
import { claudeGoalCommand, isFinished } from "@canopy/domain";
import { GoalStore, toUiGoal, toUiTurn, type GoalRow, type ThreadRow } from "../store/index.ts";
import { titleContext } from "./thread-titles.ts";
import { coreDispatch } from "./core-commands.ts";
import { coreState, InvalidError, MAX_OBJECTIVE, TTL } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreAutoTitle } from "./core-titles.ts";
import { coreBroadcastThread, coreLog, coreRun } from "./core-broadcast.ts";

export async function coreGoalToHarness(
  hostContext: GatewayCore,
  thread: ThreadRow,
  goal: GoalRow,
  directive: GoalDirective,
  objective = "",
  tokenBudget = 0n,
): Promise<void> {
  if (thread.provider === "claude") {
    // The evaluator keeps a goal turn running: stopping the goal stops the turn.
    if (directive !== GoalDirective.RUN) await hostContext.interrupt(thread.id);
    const text = claudeGoalCommand(directive === GoalDirective.RUN ? goal.objective : undefined);
    const turn = await coreGoals(hostContext, (s) => s.enqueueGoalTurn({ threadId: thread.id, goalId: goal.id, text }));
    hostContext.hub.publishThread(
      thread.id,
      create(ui.ThreadUpdateSchema, { change: { case: "turn", value: toUiTurn(turn) } }),
    );
    await hostContext.pump(thread.id);

    return;
  }

  const spec = await coreRun(hostContext, (s) => Effect.succeed(s.threadSpec(thread)));
  await coreDispatch(
    hostContext,
    thread.worker_id ?? "",
    {
      kind: {
        case: "setGoal",
        value: {
          threadId: thread.id,
          goalId: goal.id,
          objective,
          directive,
          nativeTokenBudget: tokenBudget,
          thread: spec,
        },
      },
    },
    { threadId: thread.id, ttlSeconds: TTL.setGoal },
  );
}

/** StopTask to the thread's worker for a background item (the user's Stop, an agent's stop_background_task). */
export async function coreStopTask(hostContext: GatewayCore, threadId: string, itemId: string): Promise<void> {
  const thread = await coreRun(hostContext, (s) => s.thread(threadId));
  const item = await coreRun(hostContext, (s) => s.threadItem(threadId, itemId));

  if (item?.content.case !== "backgroundTask") throw new InvalidError("background task not found");

  if (!thread.worker_id) throw new InvalidError("the thread has no worker");
  await coreDispatch(
    hostContext,
    thread.worker_id,
    { kind: { case: "stopTask", value: { threadId, taskId: item.content.value.taskId } } },
    { threadId, ttlSeconds: TTL.stopTask },
  );
}

/** SetGoal answered: a failure is shown on the goal (and its status goes back), a success clears it. */
export async function coreGoalAnswered(
  hostContext: GatewayCore,
  threadId: string,
  goalId: string,
  result: CommandResult,
): Promise<void> {
  if (!goalId) return;

  if (result.ok) {
    if (await coreGoals(hostContext, (s) => s.commandSucceeded(goalId))) await coreBroadcastGoal(hostContext, threadId);

    return;
  }

  const error = result.errorMessage ? `${result.errorCode}: ${result.errorMessage}` : result.errorCode;
  coreLog(hostContext, `goal command for thread ${threadId} failed: ${error}`);
  const goal = await coreGoals(hostContext, (s) => s.commandFailed(goalId, error));
  hostContext.hub.publishThread(
    threadId,
    create(ui.ThreadUpdateSchema, { change: { case: "goal", value: toUiGoal(goal) } }),
  );
  await coreBroadcastThread(hostContext, threadId);
}

export async function coreBroadcastGoal(hostContext: GatewayCore, threadId: string): Promise<void> {
  const goal = await coreGoals(hostContext, (s) => s.latest(threadId));

  if (goal)
    hostContext.hub.publishThread(
      threadId,
      create(ui.ThreadUpdateSchema, { change: { case: "goal", value: toUiGoal(goal) } }),
    );
}

export function coreGoals<A, E>(
  hostContext: GatewayCore,
  use: (store: GoalStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  return hostContext[coreState].actions.run(GoalStore.use(use));
}

export interface CoreGoalsMethods {
  setGoal(request: ui.SetGoalRequest): Promise<ui.Goal>;
  stopBackgroundTask(request: ui.StopBackgroundTaskRequest): Promise<void>;
}

export const coreGoalsMethods: CoreGoalsMethods = {
  // ------------------------------------------------------------------ goals and background work (UI)

  /**
   * The user's goal actions (docs/goals.md). The goal row records the decision at once; the harness confirms
   * through goal_state events.
   * - Codex: SetGoal to the worker (thread/goal/set|clear). Codex continues the thread by itself.
   * - Claude: `/goal …` as a queued turn of the goal. Claude has no pause: pause and clear interrupt the
   *   running turn (the evaluator keeps a goal turn going) and queue `/goal clear`; resume sets it again.
   */
  async setGoal(this: GatewayCore, request: ui.SetGoalRequest): Promise<ui.Goal> {
    const thread = await coreRun(this, (s) => s.thread(request.threadId));

    if (thread.owner_user_id !== this[coreState].options.userId) throw new InvalidError("thread not found");

    if (thread.archived_at) throw new InvalidError("the thread is archived");

    if (thread.runtime !== "worker" || !thread.worker_id) throw new InvalidError("goals need a worker thread");

    if (thread.provider === "grok") throw new InvalidError("Grok ACP goals are not supported yet");
    const claude = thread.provider === "claude";
    const current = await coreGoals(this, (s) => s.latest(thread.id));
    const open = current && !isFinished(current.status) ? current : undefined;
    let goal: GoalRow;

    switch (request.action) {
      case "set": {
        const objective = request.objective.trim();

        if (!objective) throw new InvalidError("objective is required");

        if (objective.length > MAX_OBJECTIVE)
          throw new InvalidError(`objective is limited to ${MAX_OBJECTIVE} characters`);

        if (claude && request.tokenBudget > 0n) throw new InvalidError("Claude goals have no token budget");

        if (claude && open?.status === "active") await this.interrupt(thread.id);
        goal = await coreGoals(this, (s) =>
          s.create({
            threadId: thread.id,
            objective,
            tokenBudget: request.tokenBudget,
            userId: this[coreState].options.userId,
          }),
        );
        await coreGoalToHarness(this, thread, goal, GoalDirective.RUN, objective, request.tokenBudget);
        break;
      }

      case "pause":
        if (open?.status !== "active") throw new InvalidError("no active goal to pause");
        goal = await coreGoals(this, (s) => s.setStatus(open.id, "paused"));
        await coreGoalToHarness(this, thread, goal, GoalDirective.PAUSE);
        break;
      case "resume":
        if (!open || open.status === "active") throw new InvalidError("no paused goal to resume");
        goal = await coreGoals(this, (s) => s.setStatus(open.id, "active"));

        // A goal the harness never confirmed (its set failed) is set again, with its objective and budget.
        if (open.native_status) await coreGoalToHarness(this, thread, goal, GoalDirective.RUN);
        else
          await coreGoalToHarness(
            this,
            thread,
            goal,
            GoalDirective.RUN,
            goal.objective,
            BigInt(goal.token_budget ?? 0),
          );
        break;
      case "clear":
        if (!open) throw new InvalidError("no open goal to clear");
        goal = await coreGoals(this, (s) => s.setStatus(open.id, "cancelled"));
        await coreGoalToHarness(this, thread, goal, GoalDirective.CLEAR);
        break;
      default:
        throw new InvalidError("action is set, pause, resume or clear");
    }

    const update = toUiGoal(goal);
    this.hub.publishThread(thread.id, create(ui.ThreadUpdateSchema, { change: { case: "goal", value: update } }));
    await coreBroadcastThread(this, thread.id);

    if (request.action === "set") coreAutoTitle(this, thread.id, titleContext({ text: request.objective }));

    return update;
  },

  /** Stops a running background task (StopTask to the worker; the item ends when the worker reports it). */
  async stopBackgroundTask(this: GatewayCore, request: ui.StopBackgroundTaskRequest): Promise<void> {
    const thread = await coreRun(this, (s) => s.thread(request.threadId));

    if (thread.owner_user_id !== this[coreState].options.userId) throw new InvalidError("thread not found");
    const item = await coreRun(this, (s) => s.threadItem(thread.id, request.itemId));

    if (item?.content.case !== "backgroundTask") throw new InvalidError("background task not found");

    if (item.status !== ItemStatus.IN_PROGRESS) throw new InvalidError("the background task is not running");
    await coreStopTask(this, thread.id, request.itemId);
  },
};
