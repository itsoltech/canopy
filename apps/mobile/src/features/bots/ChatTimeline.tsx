import { useMemo } from "react";
import { View } from "react-native";
import type { bots } from "@canopy/contracts";
import {
  botEntries,
  botParticipant,
  layoutChat,
  type ChatRow,
  type ChatMessageView,
  type ParticipantView,
} from "@canopy/domain/bot-chat";
import { ApprovalCard } from "./ApprovalCard";
import { ChatBubble } from "./ChatBubble";
import { ChatDateLine, ChatErrorLine, ChatEventLine, ExchangeLine } from "./ChatRows";

const ME: ParticipantView = { id: "me", kind: "user", name: "You" };

/**
 * A bot chat's rows, laid out like the web (web: ChatTimeline, shared `layoutChat`): date lines, runs of bubbles,
 * bot ⇄ bot markers, events, failures and cards in time order. `approvals`: the cards shown (pending, or expired
 * while open). `known`: your other bots, for names and avatars in exchange lines.
 */
export function useChatRows(
  conversation: bots.BotConversation | undefined,
  approvals: readonly bots.BotApproval[],
  known: readonly bots.Bot[],
) {
  return useMemo(() => {
    if (!conversation?.bot) return [];

    const participants = new Map<string, ParticipantView>([
      [ME.id, ME],
      ...known.map((b) => [b.id, botParticipant(b)] as const),
      [conversation.bot.id, botParticipant(conversation.bot)],
    ]);

    return layoutChat({
      entries: botEntries({ ...conversation, approvals: [...approvals] }),
      participants,
      me: ME.id,
      kind: "direct",
    });
  }, [conversation, approvals, known]);
}

/** One laid-out row; spacing follows the web's (`pt-3` before a run or card, `pt-0.5` inside a run, dates `pt-6`). */
export function ChatRowView({
  row,
  approvals,
  readOnly = false,
  onAnswer,
  onReply,
}: {
  row: ChatRow;
  approvals: readonly bots.BotApproval[];
  readOnly?: boolean;
  onAnswer?: (request: bots.AnswerBotApprovalRequest) => Promise<bots.AnswerBotApprovalResponse>;
  onReply?: ((message: ChatMessageView) => void) | undefined;
}) {
  switch (row.kind) {
    case "date":
      return (
        <View style={{ paddingTop: 24, paddingBottom: 8 }}>
          <ChatDateLine at={row.at} />
        </View>
      );
    case "unread":
      return null;
    case "event":
      return (
        <View style={{ paddingVertical: 8 }}>
          <ChatEventLine event={row.event} />
        </View>
      );
    case "exchanges":
      return (
        // Exchange and failure lines start past the avatar gutter (web: pl-9), also in a 1:1 chat.
        <View style={{ paddingVertical: 8, paddingLeft: 36 }}>
          <ExchangeLine segments={row.segments} />
        </View>
      );
    case "error":
      return (
        <View style={{ paddingTop: 12, paddingLeft: 36 }}>
          <ChatErrorLine error={row.error} sender={row.sender} readOnly={readOnly} />
        </View>
      );
    case "question":
    case "approval": {
      const approval = approvals.find((a) => a.id === row.id);

      return approval ? (
        <View style={{ paddingTop: 12 }}>
          <ApprovalCard approval={approval} readOnly={readOnly} onAnswer={onAnswer} />
        </View>
      ) : null;
    }

    default:
      return (
        <View style={{ paddingTop: row.first ? 12 : 2 }}>
          <ChatBubble
            message={row.message}
            sender={row.sender}
            mine={row.mine}
            first={row.first}
            last={row.last}
            showName={row.showName}
            gutter={false}
            onReply={readOnly ? undefined : onReply}
          />
        </View>
      );
  }
}
