import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import type { bots } from "@open-agents/contracts";
import { BotAvatar } from "./BotAvatar";
import { age } from "../navigation/SidebarThread";
import { styles, useColors } from "../../ui/theme";

export function BotListItem({ bot }: { bot: bots.Bot }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={bot.configuration?.name ?? "Bot"}
      onPress={() =>
        router.push({ pathname: "/bot/[id]", params: { id: bot.id } })
      }
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        borderRadius: 12,
        padding: 12,
        backgroundColor: pressed ? c.inset : "transparent",
      })}
    >
      <BotAvatar bot={bot} />
      <View style={{ flex: 1, gap: 4 }}>
        <View style={[styles.row, { justifyContent: "space-between" }]}>
          <Text
            style={[styles.label, { color: c.text, flex: 1 }]}
            numberOfLines={1}
          >
            {bot.configuration?.name}
          </Text>
          <Text style={[styles.caption, { color: c.muted }]}>
            {age(bot.lastMessage?.createdAt?.seconds)}
          </Text>
        </View>
        <Text numberOfLines={1} style={[styles.meta, { color: c.muted }]}>
          {bot.lastMessage?.text || "Start a conversation"}
        </Text>
      </View>
      {bot.unreadCount > 0 && (
        <Text style={[styles.caption, { color: c.accent }]}>
          {bot.unreadCount}
        </Text>
      )}
    </Pressable>
  );
}
