import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { toUiSteer, toUiTurn, type ThreadRow } from "../store/index.ts";
import { checkedQuotes, coreCheckQuoteSources } from "./quotes.ts";
import { titleContext } from "./thread-titles.ts";
import { checkedPermissionMode, coreState, InvalidError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreCheckFullAccess } from "./full-access.ts";
import { coreMessageAttachments } from "./core-attachments.ts";
import { coreComposeInput, coreMessageMentions } from "./core-mentions.ts";
import { coreCheckModel } from "./core-models.ts";
import { coreAutoTitle } from "./core-titles.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreShellInput } from "./core-shell.ts";
import { coreEnqueueTurn } from "./core-enqueue-turn.ts";
import { coreSendSteer, coreSteers, type LinkedMessageInput } from "./core-messages.ts";
import { threadDiagnostic } from "./thread-diagnostics.ts";
import type { AdmissionState, MessageResponse } from "./message-receipt.ts";

/** A validated message, admitted later under the thread lock. `thread` is the row it was validated against. */
export type PreparedMessage =
  | { replay: MessageResponse }
  | { replay?: undefined; thread: ThreadRow; goal: string }
  | {
      replay?: undefined;
      thread: ThreadRow;
      goal?: undefined;
      input: ReturnType<typeof coreComposeInput>;
      permissionMode: string;
      title: Parameters<typeof titleContext>[0];
    };

/**
 * Every check that only reads: the thread's state, attachments, quotes, mentions and the model. It runs before the
 * thread lock, so slow reads never block other writes to the thread (admission checks the row again under it).
 */
export async function prepareMessage(
  core: GatewayCore,
  request: ui.SendMessageRequest,
  linked: LinkedMessageInput | undefined,
): Promise<PreparedMessage> {
  const { threadId, clientRequestId } = request;
  const thread = await coreRun(core, (s) => s.thread(threadId));

  if (thread.owner_user_id !== core[coreState].options.userId) throw new InvalidError("thread not found");

  if (thread.archived_at) throw new InvalidError("the thread is archived");

  if (thread.rewind_pending_id) throw new InvalidError("This thread is rewinding. Wait for it to finish.");

  // Imported as history (docs/import.md): no provider session to continue in this thread.
  if (thread.imported?.mode === "history")
    throw new InvalidError("This thread was imported as history. Continue it in a new thread.");

  // The import still writes it or adopts its session (the database refuses such a turn from any path, too).
  if (thread.imported && (await core.imports.importing(threadId)))
    throw new InvalidError("This thread is still being imported. Try again when it's done.");
  const existing = await nativeReplay(core, threadId, clientRequestId);

  if (existing) return { replay: existing };

  const files =
    request.attachmentIds.length > 0
      ? await coreMessageAttachments(core, request.attachmentIds, thread.worker_id ?? "")
      : undefined;

  const quotes = checkedQuotes(request.quotes, (message) => new InvalidError(message), request.text, request.mentions);

  await coreCheckQuoteSources(core, quotes, threadId);

  if (!request.text.trim() && !files && quotes.length === 0) throw new InvalidError("message is empty");

  const shell = linked
    ? undefined
    : coreShellInput(request.text, Boolean(files || quotes.length || request.mentions.length));

  const { mentions, goal } = await coreMessageMentions(
    core,
    { id: thread.id, cwd: thread.cwd ?? "" },
    request.text,
    request.mentions,
    files?.files,
  );

  if (goal !== undefined) {
    // The platform's /goal: the rest of the message is the objective (docs/goals.md).
    if (files || quotes.length > 0) throw new InvalidError("a /goal message cannot carry attachments or quotes");

    return { thread, goal };
  }

  // Only the message's own effort is judged: the thread's default falls back when the turn starts (turnEffort).
  await coreCheckModel(core, { thread }, request.model || thread.settings.model || "", request.effort);
  const permissionMode = checkedPermissionMode(request.permissionMode);
  coreCheckFullAccess(core, thread.worker_id, request.permissionMode);

  const input =
    linked?.input ??
    shell ??
    coreComposeInput(
      core,
      thread.provider,
      request.text,
      mentions,
      files?.input(threadId, request.text, mentions),
      quotes,
    );

  return {
    thread,
    input,
    permissionMode,
    title: { text: request.text, mentions, quotes, attachments: input?.attachments },
  };
}

/**
 * Runs under the thread lock: the steer, the queued turn or the goal. Delivery to the worker and the pump are
 * deferred until the admission commits (ActionContext), so the lock never spans a worker or linked round trip.
 */
export async function admitMessage(
  core: GatewayCore,
  request: ui.SendMessageRequest,
  linked: LinkedMessageInput | undefined,
  validated: PreparedMessage,
  state: AdmissionState,
): Promise<MessageResponse> {
  const { threadId, clientRequestId } = request;
  let prepared = validated;

  // Archived, rewinding, moved or reconfigured since the checks: validate again, now under the lock.
  if (!prepared.replay && admissionKey(state) !== admissionKey(admissionState(prepared.thread)))
    prepared = await prepareMessage(core, request, linked);
  else if (!prepared.replay) {
    const existing = await nativeReplay(core, threadId, clientRequestId);

    if (existing) return existing;
  }

  if (prepared.replay) return prepared.replay;
  const { thread } = prepared;

  if (prepared.goal !== undefined)
    return {
      goal: await core.setGoal(create(ui.SetGoalRequestSchema, { threadId, action: "set", objective: prepared.goal })),
    };

  const { input, permissionMode } = prepared;
  const userId = core[coreState].options.userId;
  const running = await coreRun(core, (s) => s.steerTarget(threadId));

  if (request.delivery === ui.MessageDelivery.STEER && running && thread.worker_id) {
    const created = await coreSteers(core, (s) =>
      s.create({
        threadId,
        turnId: running.id,
        text: request.text,
        userId,
        clientRequestId,
        model: request.model,
        effort: request.effort,
        permissionMode,
        ...(linked && { linked }),
        ...(input && { input: { ...input, text: input.text ?? request.text } }),
      }),
    );

    await coreSendSteer(core, created.id);
    threadDiagnostic(core, "message_decision", {
      threadId,
      turnId: running.id,
      steerId: created.id,
      delivery: "steer",
      reason: "running_turn",
    });

    return { steer: toUiSteer(await coreSteers(core, (s) => s.steer(created.id))) };
  }

  const turn = await coreEnqueueTurn(core, {
    threadId,
    text: request.text,
    userId,
    clientRequestId,
    model: request.model,
    effort: request.effort,
    permissionMode,
    ...(linked && { linked }),
    ...(input && { input }),
  });

  await core.pump(threadId);
  threadDiagnostic(core, "message_decision", {
    threadId,
    turnId: turn.id,
    delivery: turn.dispatched ? "new_turn" : "queue",
    reason: running ? "queue_requested" : turn.dispatched ? "no_running_turn" : "thread_not_ready",
  });

  if (turn.ordinal === 1) coreAutoTitle(core, threadId, titleContext(prepared.title));

  return { turn };
}

/** A steer or turn admitted with this request id by any path (also without a receipt). */
async function nativeReplay(
  core: GatewayCore,
  threadId: string,
  clientRequestId: string,
): Promise<MessageResponse | undefined> {
  const steer = await coreSteers(core, (s) => s.byClientRequest(threadId, clientRequestId));

  if (steer) return { steer: toUiSteer(steer) };
  const turn = await coreRun(core, (s) => s.turnByClientRequest(threadId, clientRequestId));

  return turn && { turn: toUiTurn(turn) };
}

/** What the checks read from the thread row, as the admission lock reads it (message-receipt.ts). */
function admissionState(thread: ThreadRow): AdmissionState {
  return {
    worker_id: thread.worker_id,
    cwd: thread.cwd,
    provider: thread.provider,
    provider_profile_id: thread.provider_profile_id,
    model: thread.settings.model ?? "",
    archived: Boolean(thread.archived_at),
    deleted: Boolean(thread.deleted_at),
    rewind_pending_id: thread.rewind_pending_id ?? null,
    import_mode: thread.imported?.mode ?? null,
  };
}

/** A change in any of these means the checks must run again. */
function admissionKey(state: AdmissionState): string {
  return JSON.stringify([
    state.worker_id,
    state.cwd,
    state.provider,
    state.provider_profile_id,
    state.model,
    state.archived,
    state.deleted,
    state.rewind_pending_id,
    state.import_mode,
  ]);
}
