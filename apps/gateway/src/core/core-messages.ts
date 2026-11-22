import { create, type JsonValue } from "@bufbuild/protobuf";
import { ui, type CommandResult } from "@canopy/contracts";
import { Effect, Match } from "effect";
import { mentionsFromJson } from "./mentions.ts";
import { interruptTarget } from "../store/interrupt-target.ts";
import { SteerStore, toUiDelivery, toUiSteer, turnEffort } from "../store/index.ts";
import { coreDispatch } from "./core-commands.ts";
import { checkedPermissionMode, coreState, InvalidError, TTL } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { threadSandbox } from "../store/thread-sandbox.ts";
import { SANDBOX_STEER_UNAVAILABLE } from "./thread-sandbox.ts";
import { withSandboxUpdate } from "./update-thread-sandbox.ts";
import { coreCheckFullAccess } from "./full-access.ts";
import { coreCheckModel, coreProfileModels } from "./core-models.ts";
import { coreUiThread } from "./core-titles.ts";
import { coreBroadcastThread, coreBroadcastTurn, coreRun } from "./core-broadcast.ts";
import { coreBus } from "./core-schedules.ts";
import type { TurnRow } from "../store/rows.ts";
import { storedShellResult } from "../store/shell-input.ts";
import { messageReceipt, type MessageResponse } from "./message-receipt.ts";
import { admitMessage, prepareMessage } from "./core-send-message.ts";
import { threadDiagnostic } from "./thread-diagnostics.ts";

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

  if (threadSandbox(thread)) return coreQueueSteer(hostContext, steerId, SANDBOX_STEER_UNAVAILABLE);

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
          serviceTier: steer.service_tier ?? "",
          input: {
            text: steer.input.text,
            shellCommand: steer.input.shellCommand,
            shellInputId: steer.input.shellInputId ?? "",
            shellResult: storedShellResult(steer.input.shellResult),
            authorUserId: steer.author_user_id ?? "",
            authorAgentId: steer.source_thread_id ?? "",
            mentions: mentionsFromJson(steer.input.delivered),
            attachments: (steer.input.attachments ?? []).map((a) => ({
              attachmentId: a.id,
              sha256: a.sha256,
              sizeBytes: BigInt(a.sizeBytes),
              mimeType: a.mimeType,
              name: a.name,
              path: a.path,
              kind: a.kind,
            })),
          },
        },
      },
    },
    { threadId: steer.thread_id, ttlSeconds: TTL.steerTurn, steerId },
  );
}

export async function coreSteerAnswered(
  hostContext: GatewayCore,
  threadId: string,
  steerId: string,
  result: CommandResult,
): Promise<void> {
  if (result.ok) {
    const steer = await coreSteers(hostContext, (s) => s.accepted(steerId));

    if (steer.status === "accepted")
      threadDiagnostic(hostContext, "steer_delivery", {
        threadId,
        turnId: steer.turn_id,
        steerId,
        outcome: "accepted",
      });
    await corePublishSteer(hostContext, steerId);

    return;
  }

  if (result.errorCode.startsWith("SHELL_")) {
    const steer = await coreSteers(hostContext, (s) => s.failed(steerId, result.errorMessage));

    if (steer.status === "failed")
      threadDiagnostic(hostContext, "steer_delivery", {
        threadId,
        turnId: steer.turn_id,
        steerId,
        outcome: "failed",
        reason: "shell_failed",
      });
    await corePublishSteer(hostContext, steerId);

    return;
  }

  const reason = Match.value(result.errorCode).pipe(
    Match.when("STEER_ATTACHMENTS_UNSUPPORTED", () => result.errorMessage),
    Match.when("STEER_NOT_RUNNING", () => "the turn ended before the message could join it"),
    Match.orElse(
      () => `the provider did not take the message into the running turn: ${result.errorMessage || result.errorCode}`,
    ),
  );

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
    await hostContext.checkWatches.release(current.thread_id, steerId);

    if (current.status === "pending" || current.status === "accepted" || current.status === "dropped")
      threadDiagnostic(hostContext, "steer_delivery", {
        threadId: current.thread_id,
        turnId: current.turn_id,
        steerId,
        outcome: "released",
        reason: "not_consumed",
      });
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

  if (turn) {
    threadDiagnostic(hostContext, "steer_delivery", {
      threadId: steer.thread_id,
      turnId: steer.turn_id,
      steerId,
      outcome: "requeued",
      reason: "not_consumed",
      queuedTurnId: turn.id,
    });
    await coreBroadcastTurn(hostContext, steer.thread_id, turn.id);
  }
}

export async function corePublishSteer(hostContext: GatewayCore, steerId: string, consumed = false): Promise<void> {
  const steer = await coreSteers(hostContext, (s) => s.steer(steerId)).catch(() => undefined);

  if (!steer) return;

  if (consumed && steer.status === "delivered")
    threadDiagnostic(hostContext, "steer_delivery", {
      threadId: steer.thread_id,
      turnId: steer.turn_id,
      steerId,
      outcome: "consumed",
    });
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
    ownerInput?: boolean,
  ): Promise<MessageResponse>;
  updateThread(request: ui.UpdateThreadRequest, ownerInput?: boolean): Promise<ui.Thread>;
  interrupt(threadId: string): Promise<void>;
}

const messageActions: Omit<CoreMessagesMethods, "sendMessage"> = {
  /** The thread's default model, effort and permission mode for turns without an override. */
  async updateThread(this: GatewayCore, request: ui.UpdateThreadRequest, ownerInput = false): Promise<ui.Thread> {
    const row = await withSandboxUpdate(this, request, ownerInput, (binding) =>
      updateThreadDefaults(this, request, binding),
    );

    await coreBroadcastThread(this, row.id);

    return coreUiThread(this, row);
  },

  async interrupt(this: GatewayCore, threadId: string): Promise<void> {
    const { actions, options } = this[coreState];
    await actions.transaction(async () => {
      const target = await actions.run(interruptTarget(options.userId, threadId));

      if (!target) return;
      const { workerId, turnId } = target;

      if (target.dispatch)
        await coreDispatch(
          this,
          workerId,
          { kind: { case: "interruptTurn", value: { threadId, turnId } } },
          { threadId, turnId, ttlSeconds: TTL.interruptTurn },
        );

      if (target.cancelled) actions.defer(() => coreBroadcastTurn(this, threadId, turnId, "finished"));
    });
  },
};

async function updateThreadDefaults(thisCore: GatewayCore, request: ui.UpdateThreadRequest, binding?: JsonValue) {
  const thread = await coreRun(thisCore, (s) => s.thread(request.threadId));

  if (thread.owner_user_id !== thisCore[coreState].options.userId || thread.archived_at)
    throw new InvalidError("thread not found");

  if (request.resetAutoArchiveOnMerge && request.autoArchiveOnMerge !== undefined)
    throw new InvalidError("Choose an override or reset automatic archiving, not both.");
  const title = request.title?.trim();

  if (title !== undefined && (!title || title.length > 200 || /[\r\n\p{Cc}]/u.test(title)))
    throw new InvalidError("title must be one line with 1–200 characters");
  const model = request.model ?? thread.settings.model ?? "";
  // The requested effort is judged; the current default follows a new model (none without efforts, else the
  // model's default when it does not offer it).
  const current = thread.settings.effort ?? "";
  let effort = current;

  if (request.model !== undefined || request.effort !== undefined) {
    await coreCheckModel(thisCore, { thread }, model, request.effort ?? "");
    effort = turnEffort((await coreProfileModels(thisCore, { thread })).models, model, request.effort ?? current);
  }

  if (request.model !== undefined || request.serviceTier !== undefined)
    await coreCheckModel(thisCore, { thread }, model, "", request.serviceTier ?? thread.settings.serviceTier ?? "");

  // Only the owner (UI) changes the mode; agents have no bus tool for it (docs/ui-api.md, FULL_AUTO and
  // FULL_ACCESS only deliberately).
  const permissionMode = request.permissionMode === undefined ? "" : checkedPermissionMode(request.permissionMode);

  if (request.permissionMode !== undefined) coreCheckFullAccess(thisCore, thread.worker_id, request.permissionMode);

  if (title !== undefined) await coreRun(thisCore, (s) => s.renameThread(thread.id, title));

  return coreRun(thisCore, (s) =>
    s.updateThreadSettings(
      request.threadId,
      {
        ...(request.model !== undefined && { model: request.model }),
        ...(request.serviceTier !== undefined && { serviceTier: request.serviceTier }),
        ...((request.effort !== undefined || effort !== current) && { effort }),
        ...(permissionMode && { permissionMode }),
        ...(binding !== undefined && { sandboxProfile: binding }),
      },
      request.resetAutoArchiveOnMerge ? null : request.autoArchiveOnMerge,
    ),
  );
}

export const coreMessagesMethods: CoreMessagesMethods = {
  ...messageActions,
  /**
   * A message: the next turn (queue), or into the running turn (steer; without one it is queued too).
   * Idempotent by client_request_id across both.
   */
  sendMessage(this: GatewayCore, request, linked, ownerInput = false) {
    return messageReceipt(this, request, {
      prepare: () => prepareMessage(this, request, linked),
      admit: (prepared, state) => admitMessage(this, request, linked, prepared, state, ownerInput),
    });
  },
};
