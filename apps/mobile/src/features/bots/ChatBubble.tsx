import { Text, View } from "react-native";
import type { ChatMessageView, ParticipantView } from "@canopy/domain/bot-chat";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/markdown";
import { font, styles, useColors, useTypography } from "../../ui/theme";
import { useTone } from "../../ui/tone";
import { MascotAvatar } from "./BotAvatar";
import { botInk } from "./bot-ink";

/**
 * One message in a run (web: ChatBubble, MessageRow). Bots write markdown on soft grey; your messages are plain text
 * on the dark neutral (light in dark mode), on the right. Corners facing the rest of the run are tighter. Group and
 * watched chats add an avatar beside the last bubble and the sender's name above the first; a 1:1 chat has neither.
 */
export function ChatBubble({
  message,
  sender,
  mine,
  first,
  last,
  showName,
  gutter,
}: {
  message: ChatMessageView;
  sender: ParticipantView | undefined;
  mine: boolean;
  first: boolean;
  last: boolean;
  showName: boolean;
  gutter: boolean;
}) {
  const c = useColors();
  const type = useTypography();
  const rose = useTone("rose").text;
  const end = mine;
  const tight = 6;

  const corners = {
    borderRadius: 20,
    ...(!first && (end ? { borderTopRightRadius: tight } : { borderTopLeftRadius: tight })),
    ...(!last && (end ? { borderBottomRightRadius: tight } : { borderBottomLeftRadius: tight })),
  };

  return (
    <View style={{ flexDirection: end ? "row-reverse" : "row", alignItems: "flex-end", gap: 8 }}>
      {!mine && gutter && (
        <View style={{ width: 28 }}>
          {last && sender && (
            <MascotAvatar id={sender.id} name={sender.name} shape={sender.shape} color={sender.color} size={28} />
          )}
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 4, alignItems: end ? "flex-end" : "flex-start" }}>
        {showName && sender && (
          <Text
            style={[
              styles.meta,
              { paddingHorizontal: 12, fontFamily: font.medium, color: botInk(sender.color, c.dark, c.muted) },
            ]}
          >
            {sender.name}
          </Text>
        )}
        {message.replyTo && (
          <View
            style={[
              styles.row,
              { gap: 6, maxWidth: "85%", paddingHorizontal: 12, flexDirection: end ? "row-reverse" : "row" },
            ]}
          >
            <Icon name="arrow-uturn-left" size={14} color={c.faint} />
            <Text numberOfLines={1} style={[styles.meta, { flexShrink: 1, color: c.muted }]}>
              {message.replyTo.excerpt}
            </Text>
          </View>
        )}
        <View
          accessibilityLabel={`${mine ? "You" : (sender?.name ?? "Unknown")}: ${message.text}`}
          style={[
            corners,
            {
              maxWidth: "85%",
              paddingHorizontal: 16,
              paddingVertical: 8,
              backgroundColor: mine ? c.botUserBubble : c.botBubble,
              opacity: message.delivery === "sending" ? 0.6 : 1,
            },
          ]}
        >
          {mine ? (
            <Text selectable style={[type.body, { color: c.botUserText }]}>
              {message.text}
            </Text>
          ) : (
            <Markdown text={message.text} />
          )}
        </View>
        {message.delivery && (
          <View style={[styles.row, { gap: 4, paddingHorizontal: 12 }]}>
            {message.delivery === "failed" && <Icon name="exclamation-circle" size={14} color={rose} />}
            <Text style={[styles.meta, { color: message.delivery === "failed" ? rose : c.muted }]}>
              {message.delivery === "failed" ? "Not sent" : "Sending…"}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}
