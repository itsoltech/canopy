import { TurnOrigin, TurnOutcome, TurnEndSource, type UserInput } from "@canopy/contracts";
import { Schema } from "effect";
import { claudeContent } from "./input.ts";
import { userItem, userMessage } from "./session-io.ts";
import { sessionCompletion } from "./session-completion.ts";
import type { ClaudeThreadContext, Session } from "./thread-types.ts";
import type { sessionOutput } from "./session-output.ts";
import type { sessionTurns } from "./session-turns.ts";

export async function submitClaudeTurn(
  ctx: ClaudeThreadContext,
  session: Session,
  turnId: string,
  input: UserInput,
  model: string,
  canSubmit: () => boolean,
  turns: ReturnType<typeof sessionTurns>,
  record: ReturnType<typeof sessionOutput>["record"],
  connectorNote?: string,
): Promise<void> {
  const content = await claudeContent(connectorNote ? { ...input, text: `${input.text}\n\n${connectorNote}` } : input);
  const current = () => ctx.sessions.get(session.threadId) === session && !session.closing && canSubmit();

  if (!current()) return;
  await turns.beginTurn(session, turnId, TurnOrigin.COMMAND, model);
  await record(
    session.threadId,
    userItem(turnId, `user:${turnId}`, turnId, input.text, input.authorUserId, input.mentions),
  );

  if (!current()) {
    const { finishTurn } = sessionCompletion(ctx, session, record, turns.dropSteers);
    await finishTurn({ outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.USER, reason: "interrupted" });
    turns.closeWhenIdle(session);

    return;
  }

  session.input.push(
    userMessage(content, {
      uuid: Schema.decodeUnknownSync(
        Schema.TemplateLiteral([
          Schema.String,
          "-",
          Schema.String,
          "-",
          Schema.String,
          "-",
          Schema.String,
          "-",
          Schema.String,
        ]),
      )(turnId),
    }),
  );
}
