import { create } from "@bufbuild/protobuf";
import { InteractionResponseSchema, ui } from "@canopy/contracts";
import { type WorkerConnection } from "../worker-link/index.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreBroadcastThread, coreRun } from "./core-broadcast.ts";

/** Stores the answer (user or parent agent), announces it and passes it to the waiting worker. */
export async function coreAnswer(
  hostContext: GatewayCore,
  by: { userId: string; botId?: string } | { threadId: string },
  request: ui.AnswerInteractionRequest,
): Promise<ui.Interaction> {
  const interaction = await coreRun(hostContext, (s) => s.answerInteraction(request.requestId, by, request));
  await corePublishInteraction(hostContext, interaction);

  if (interaction.toolName === "ask_user") {
    if (!hostContext[coreState].actions.defer(() => hostContext.bus.deliverAnswers()))
      await hostContext.bus.deliverAnswers();

    return interaction;
  }

  const thread = await coreRun(hostContext, (s) => s.thread(interaction.threadId));
  const connection = thread.worker_id ? hostContext.link.connections.get(thread.worker_id) : undefined;

  // Offline: the worker re-sends the request after reconnecting and gets the stored answer.
  if (
    connection?.isOpen &&
    !hostContext[coreState].actions.defer(() => coreSendAnswer(hostContext, connection, request))
  )
    coreSendAnswer(hostContext, connection, request);

  return interaction;
}

export async function corePublishInteraction(hostContext: GatewayCore, interaction: ui.Interaction): Promise<void> {
  hostContext.hub.publishThread(
    interaction.threadId,
    create(ui.ThreadUpdateSchema, { change: { case: "interaction", value: interaction } }),
  );
  const stored = await coreRun(hostContext, (s) => s.interactionEvent(interaction.requestId));

  if (stored)
    hostContext.hub.publishThread(
      interaction.threadId,
      create(ui.ThreadUpdateSchema, { change: { case: "event", value: stored } }),
    );
  await coreBroadcastThread(hostContext, interaction.threadId);
}

// ------------------------------------------------------------------ helpers

export function coreSendAnswer(
  hostContext: GatewayCore,
  connection: WorkerConnection,
  answer: ui.AnswerInteractionRequest,
): void {
  try {
    connection.send({
      case: "interactionResponse",
      value: create(InteractionResponseSchema, {
        requestId: answer.requestId,
        allow: answer.allow,
        allowForSession: answer.allowForSession,
        message: answer.message,
        answerJson: answer.answerJson,
        cancelled: answer.cancelled,
      }),
    });
  } catch {
    // closed meanwhile: re-sent request gets the stored answer
  }
}

export interface CoreInteractionsMethods {
  answerInteraction(request: ui.AnswerInteractionRequest, botId?: string): Promise<ui.Interaction>;
}

export const coreInteractionsMethods: CoreInteractionsMethods = {
  /** `botId`: a bot answered on the user's behalf (its answer_interaction tool); the timeline names it. */
  async answerInteraction(
    this: GatewayCore,
    request: ui.AnswerInteractionRequest,
    botId?: string,
  ): Promise<ui.Interaction> {
    return coreAnswer(this, { userId: this[coreState].options.userId, ...(botId && { botId }) }, request);
  },
};
