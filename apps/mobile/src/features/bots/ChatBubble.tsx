import { Text, View } from "react-native";
import type { bots } from "@open-agents/contracts";
import { Markdown } from "../../ui/markdown";
import { styles, useColors } from "../../ui/theme";

export function ChatBubble({
  message,
  bot,
}: {
  message: bots.BotMessage;
  bot?: bots.Bot;
}) {
  const c = useColors();
  const mine = message.senderId !== bot?.id;
  if (message.kind === "event")
    return (
      <Text style={[styles.caption, { color: c.muted, textAlign: "center" }]}>
        {message.text}
      </Text>
    );
  return (
    <View style={{ alignItems: mine ? "flex-end" : "flex-start", gap: 4 }}>
      <View
        style={{
          maxWidth: "85%",
          backgroundColor: mine ? c.botUserBubble : c.inset,
          borderRadius: 20,
          borderBottomRightRadius: mine ? 6 : 20,
          borderBottomLeftRadius: mine ? 20 : 6,
          paddingHorizontal: 16,
          paddingVertical: mine ? 6 : 10,
        }}
      >
        {mine ? (
          <Text selectable style={[styles.body, { color: c.botUserText }]}>
            {message.text}
          </Text>
        ) : (
          <Markdown
            text={
              message.failed
                ? "Could not complete this response."
                : message.text
            }
          />
        )}
      </View>
    </View>
  );
}
