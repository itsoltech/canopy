import type { Client } from "@connectrpc/connect";
import { InteractionKind, type ui } from "@canopy/contracts";
import type { UserAnswer } from "@canopy/domain";
import { encodeAnswers, parseQuestions } from "@canopy/domain/questions";

/** Use the same parser and provider-specific wire answers as the web question panel. */
export function mobileQuestions(interaction: ui.Interaction) {
  if (
    interaction.kind !== InteractionKind.QUESTION ||
    !["AskUserQuestion", "request_user_input", "ask_user"].includes(interaction.toolName)
  )
    return [];
  const questions = parseQuestions(interaction.requestJson);

  return questions.length <= 4 &&
    questions.every((q) => q.question.trim()) &&
    new Set(questions.map((q) => q.id)).size === questions.length
    ? questions
    : [];
}

export function answerQuestions(
  api: Client<typeof ui.GatewayService>,
  interaction: ui.Interaction,
  answers: readonly UserAnswer[],
  dismissed = false,
) {
  return api.answerInteraction(
    {
      requestId: interaction.requestId,
      ...(dismissed
        ? { cancelled: true }
        : {
            answerJson: encodeAnswers(interaction.toolName, mobileQuestions(interaction), answers),
          }),
    },
    { timeoutMs: 20_000 },
  );
}
