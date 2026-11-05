import { create } from "@bufbuild/protobuf";
import { ui, type CommandResult } from "@canopy/contracts";
import { Effect } from "effect";
import { mentionsFromJson } from "./mentions.ts";
import { NotFound, SteerStore, toUiDelivery, toUiSteer, toUiTurn, turnEffort } from "../store/index.ts";
import { checkedQuotes } from "./quotes.ts";
import { titleContext } from "./thread-titles.ts";
import { coreDispatch } from "./core-commands.ts";
import { checkedPermissionMode, coreState, InvalidError, TTL } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreCheckFullAccess } from "./full-access.ts";
import { coreMessageAttachments } from "./core-attachments.ts";
import { coreComposeInput, coreMessageMentions } from "./core-mentions.ts";
import { coreCheckModel, coreProfileModels } from "./core-models.ts";
import { coreAutoTitle, coreUiThread } from "./core-titles.ts";
import { coreBroadcastThread, coreBroadcastTurn, coreRun } from "./core-broadcast.ts";
import { coreBus } from "./core-schedules.ts";
import type { TurnRow } from "../store/rows.ts";
import { coreShellInput } from "./core-shell.ts";
import { storedShellResult } from "../store/shell-input.ts";
import { coreEnqueueTurn } from "./core-enqueue-turn.ts";

/** Internal linked input, prepared by the peer gateway rather than a public UI request. */
export interface LinkedMessageInput {
  callId: string;
  hops: number;
  input: TurnRow["input"] & { text: string };
}

/** SteerTurn to the worker (outbox); the result decides between accepted and the queue. */
export async function coreSendSteer(hostContext: GatewayCore, steerId: string): Promise<void> {
  const steer = await coreSteers(hostContext, (s) => s.steer(steerId));

  if (steer.status !== "pending") return;
  const thread = await coreRun(hostContext, (s) => s.thread(steer.thread_id));
  await corePublishSteer(hostContext, steerId);

  if (!thread.worker_id) return void (await coreQueueSteer(hostContext, steerId, "the thread has no worker"));
  await coreDispatch(
    hostContext,
    thread.worker_id,
    {
      commandId: steerId,
      kind: {
        case: "steerTurn",
        value: {
          threadId: steer.thread_id,
          turnId: steer.turn_id,
          inputId: steer.id,
          input: {
            text: steer.input.text,
            shellCommand: steer.input.shellCommand,
            shellInputId: steer.input.shellInputId ?? "",
            shellResult: storedShellResult(steer.input.shellResult),
            authorUserId: steer.author_user_id ?? "",
            authorAgentId: steer.source_thread_id ?? "",
            mentions: mentionsFromJson(steer.input.delivered),
          },
        },
      },
    },
    { threadId: steer.thread_id, ttlSeconds: TTL.steerTurn },
  );
}

export async function coreSteerAnswered(
  hostContext: GatewayCore,
  threadId: string,
  steerId: string,
  result: CommandResult,
): Promise<void> {
  if (result.ok) {
    await coreSteers(hostContext, (s) => s.accepted(steerId));
    await corePublishSteer(hostContext, steerId);

    return;
  }

  if (result.errorCode.startsWith("SHELL_")) {
    await coreSteers(hostContext, (s) => s.failed(steerId, result.errorMessage));
    await corePublishSteer(hostContext, steerId);

    return;
  }

  const reason =
    result.errorCode === "STEER_NOT_RUNNING"
      ? "the turn ended before the message could join it"
      : `the provider did not take the message into the running turn: ${result.errorMessage || result.errorCode}`;

  await coreQueueSteer(hostContext, steerId, reason);
  await hostContext.pump(threadId);
}

/** The steer runs as the next turn instead (reason "" keeps the stored one, e.g. from a steer_dropped notice). */
export async function coreQueueSteer(hostContext: GatewayCore, steerId: string, reason: string): Promise<void> {
  const current = await coreSteers(hostContext, (s) => s.steer(steerId));

  // A note about background tasks: no turn from the steer, its notes are delivered anew.
  if (current.background_note) {
    await hostContext.backgroundTasks.release(
      current.thread_id,
      steerId,
      reason || current.reason || "the turn ended before the note could join it",
    );
    await corePublishSteer(hostContext, steerId);

    return;
  }

  const { steer, turn } = await coreSteers(hostContext, (s) =>
    s.queue(steerId, reason || current.reason || "the turn ended before the message could join it"),
  );

  hostContext.hub.publishThread(
    steer.thread_id,
    create(ui.ThreadUpdateSchema, { change: { case: "steer", value: toUiSteer(steer) } }),
  );

  if (turn) await coreBroadcastTurn(hostContext, steer.thread_id, turn.id);
}

export async function corePublishSteer(hostContext: GatewayCore, steerId: string): Promise<void> {
  const steer = await coreSteers(hostContext, (s) => s.steer(steerId)).catch(() => undefined);

  if (!steer) return;
  hostContext.hub.publishThread(
    steer.thread_id,
    create(ui.ThreadUpdateSchema, { change: { case: "steer", value: toUiSteer(steer) } }),
  );

  // An agent's steer: the sender's card follows it (on its way, joined, or queued instead).
  if (steer.agent_call_id) await corePublishDeliveries(hostContext, { steerId });
}

/** The calling threads of the bus calls that reached this turn or steer hear its new status (their timeline cards). */
export async function corePublishDeliveries(
  hostContext: GatewayCore,
  by: { turnId: string } | { steerId: string },
): Promise<void> {
  for (const row of await coreBus(hostContext, (s) => s.deliveries(by))) {
    hostContext.hub.publishThread(
      row.source_thread_id,
      create(ui.ThreadUpdateSchema, { change: { case: "busDelivery", value: toUiDelivery(row) } }),
    );
  }
}

export function coreSteers<A, E>(
  hostContext: GatewayCore,
  use: (store: SteerStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  return hostContext[coreState].actions.run(SteerStore.use(use));
}

export interface CoreMessagesMethods {
  sendMessage(
    request: ui.SendMessageRequest,
    linked?: LinkedMessageInput,
  ): Promise<{ turn?: ui.Turn; steer?: ui.Steer; goal?: ui.Goal }>;
  updateThread(request: ui.UpdateThreadRequest): Promise<ui.Thread>;
  interrupt(threadId: string): Promise<void>;
}

export const coreMessagesMethods: CoreMessagesMethods = {
  /**
   * A message: the next turn (queue), or into the running turn (steer; without one it is queued too).
   * Idempotent by client_request_id across both.
   */
  async sendMessage(
    this: GatewayCore,
    request: ui.SendMessageRequest,
    linked?: LinkedMessageInput,
  ): Promise<{ turn?: ui.Turn; steer?: ui.Steer; goal?: ui.Goal }> {
    const { threadId, clientRequestId } = request;
    const thread = await coreRun(this, (s) => s.thread(threadId));

    if (thread.owner_user_id !== this[coreState].options.userId) throw new InvalidError("thread not found");

    if (thread.archived_at) throw new InvalidError("the thread is archived");
    const existingSteer = await coreSteers(this, (s) => s.byClientRequest(threadId, clientRequestId));

    if (existingSteer) return { steer: toUiSteer(existingSteer) };
    const existingTurn = await coreRun(this, (s) => s.turnByClientRequest(threadId, clientRequestId));

    if (existingTurn) return { turn: toUiTurn(existingTurn) };

    const files =
      request.attachmentIds.length > 0
        ? await coreMessageAttachments(this, request.attachmentIds, thread.worker_id ?? "")
        : undefined;

    const quotes = checkedQuotes(request.quotes, (message) => new InvalidError(message));

    if (!request.text.trim() && !files && quotes.length === 0) throw new InvalidError("message is empty");

    const shell = linked
      ? undefined
      : coreShellInput(request.text, Boolean(files || quotes.length || request.mentions.length));

    const { mentions, goal } = await coreMessageMentions(
      this,
      { id: thread.id, cwd: thread.cwd ?? "" },
      request.text,
      request.mentions,
      files?.files,
    );

    if (goal !== undefined) {
      // The platform's /goal: the rest of the message is the objective (docs/goals.md).
      if (files || quotes.length > 0) throw new InvalidError("a /goal message cannot carry attachments or quotes");

      return {
        goal: await this.setGoal(create(ui.SetGoalRequestSchema, { threadId, action: "set", objective: goal })),
      };
    }

    // Only the message's own effort is judged: the thread's default falls back when the turn starts (turnEffort).
    await coreCheckModel(this, { thread }, request.model || thread.settings.model || "", request.effort);
    const permissionMode = checkedPermissionMode(request.permissionMode);
    coreCheckFullAccess(this, thread.worker_id, request.permissionMode);

    // A message with attachments is always the next turn: its files go to the worker before the turn starts.
    // Quotes travel in the text (their note), so a message with quotes steers like any other.
    if (request.delivery === ui.MessageDelivery.STEER && !files) {
      const running = await coreRun(this, (s) => s.steerTarget(threadId));

      if (running && thread.worker_id) {
        const steerInput =
          linked?.input ?? shell ?? coreComposeInput(this, thread.provider, request.text, mentions, undefined, quotes);

        const steer = await coreSteers(this, (s) =>
          s.create({
            threadId,
            turnId: running.id,
            text: request.text,
            userId: this[coreState].options.userId,
            clientRequestId,
            model: request.model,
            effort: request.effort,
            permissionMode,
            ...(linked && { linked }),
            ...(steerInput && { input: { ...steerInput, text: steerInput.text ?? request.text } }),
          }),
        );

        await coreSendSteer(this, steer.id);

        return { steer: toUiSteer(await coreSteers(this, (s) => s.steer(steer.id))) };
      }
    }

    const input =
      linked?.input ??
      shell ??
      coreComposeInput(
        this,
        thread.provider,
        request.text,
        mentions,
        files?.input(threadId, request.text, mentions),
        quotes,
      );

    const turn = await coreEnqueueTurn(this, {
      threadId,
      text: request.text,
      userId: this[coreState].options.userId,
      clientRequestId,
      model: request.model,
      effort: request.effort,
      permissionMode,
      ...(linked && { linked }),
      ...(input && { input }),
    });

    await this.pump(threadId);

    if (turn.ordinal === 1)
      coreAutoTitle(
        this,
        threadId,
        titleContext({ text: request.text, mentions, quotes, attachments: input?.attachments }),
      );

    return { turn };
  },

  /** The thread's default model, effort and permission mode for turns without an override. */
  async updateThread(this: GatewayCore, request: ui.UpdateThreadRequest): Promise<ui.Thread> {
    const thread = await coreRun(this, (s) => s.thread(request.threadId));

    if (thread.owner_user_id !== this[coreState].options.userId || thread.archived_at)
      throw new InvalidError("thread not found");
    const title = request.title?.trim();

    if (title !== undefined && (!title || title.length > 200 || /[\r\n\p{Cc}]/u.test(title)))
      throw new InvalidError("title must be one line with 1–200 characters");
    const model = request.model ?? thread.settings.model ?? "";
    // The requested effort is judged; the current default follows a new model (none without efforts, else the
    // model's default when it does not offer it).
    const current = thread.settings.effort ?? "";
    let effort = current;

    if (request.model !== undefined || request.effort !== undefined) {
      await coreCheckModel(this, { thread }, model, request.effort ?? "");
      effort = turnEffort((await coreProfileModels(this, { thread })).models, model, request.effort ?? current);
    }

    // Only the owner (UI) changes the mode; agents have no bus tool for it (docs/ui-api.md, FULL_AUTO and
    // FULL_ACCESS only deliberately).
    const permissionMode = request.permissionMode === undefined ? "" : checkedPermissionMode(request.permissionMode);

    if (request.permissionMode !== undefined) coreCheckFullAccess(this, thread.worker_id, request.permissionMode);

    if (title !== undefined) await coreRun(this, (s) => s.renameThread(thread.id, title));

    const row = await coreRun(this, (s) =>
      s.updateThreadSettings(request.threadId, {
        ...(request.model !== undefined && { model: request.model }),
        ...((request.effort !== undefined || effort !== current) && { effort }),
        ...(permissionMode && { permissionMode }),
      }),
    );

    await coreBroadcastThread(this, row.id);

    return coreUiThread(this, row);
  },

  async interrupt(this: GatewayCore, threadId: string): Promise<void> {
    const thread = await coreRun(this, (s) => s.thread(threadId));

    if (thread.owner_user_id !== this[coreState].options.userId) throw new NotFound("thread not found");
    const turn = await coreRun(this, (s) => s.runningTurn(threadId));

    if (!turn || !thread.worker_id) return;
    await coreDispatch(
      this,
      thread.worker_id,
      { kind: { case: "interruptTurn", value: { threadId, turnId: turn.id } } },
      { threadId, turnId: turn.id, ttlSeconds: TTL.interruptTurn },
    );
  },
};
