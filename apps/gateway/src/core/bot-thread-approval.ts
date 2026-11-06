import { create } from "@bufbuild/protobuf";
import { ui, bots } from "@canopy/contracts";
import { Invalid } from "../store/store.ts";
import type { GatewayCore } from "./core.ts";
import { coreState } from "./core-context.ts";
import { splitId } from "@canopy/domain/computers";

export async function answerBotThreadApproval(core: GatewayCore, request: bots.AnswerBotApprovalRequest) {
  const user = core[coreState].options.userId;

  if (splitId(request.approvalId).node) {
    if (request.ruleOptionId || request.answer) throw new Invalid("Open the thread for other responses.");

    const result = await core.linkedAgents.ui(
      "AnswerInteraction",
      create(ui.AnswerInteractionRequestSchema, { requestId: request.approvalId, allow: request.approve }),
      ui.AnswerInteractionResponseSchema,
    );

    return create(bots.BotApprovalSchema, {
      id: request.approvalId,
      requestId: request.approvalId,
      threadId: result.interaction?.threadId ?? "",
      kind: "approval",
      status: result.interaction?.status === "allowed" ? "approved" : "discarded",
    });
  }

  const card = await core.bots.run((s) => s.threadApproval(user, request.approvalId));

  if (!card) return undefined;

  if (request.ruleOptionId || request.answer)
    throw new Invalid("Thread tool requests accept Approve or Deny. Open the thread for other responses.");

  if (card.status !== "pending") return card;
  const answer = create(ui.AnswerInteractionRequestSchema, { requestId: card.requestId, allow: request.approve });

  await core.answerInteraction(answer);

  return core.bots.run((s) => s.threadApproval(user, request.approvalId));
}
