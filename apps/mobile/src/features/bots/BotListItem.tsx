import { Pressable, Text, View } from "react-native";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useLayout } from "../../state/layout";
import type { bots } from "@canopy/contracts";
import { BotAvatar } from "./BotAvatar";
import { age } from "../navigation/SidebarThread";
import { styles, useColors } from "../../ui/theme";

export function BotListItem({ bot }: { bot: bots.Bot }) {
  const c = useColors();
  const layout = useLayout();
  const pathname = usePathname();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const active = layout.wide && pathname.startsWith("/bot/") && id === bot.id;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={bot.configuration?.name ?? "Bot"}
      accessibilityState={{ selected: active }}
      onPress={() => layout.open({ pathname: "/bot/[id]", params: { id: bot.id } })}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        borderRadius: 12,
        padding: 12,
        backgroundColor: pressed || active ? c.inset : "transparent",
      })}
    >
      <BotAvatar bot={bot} />
      <View style={{ flex: 1, gap: 4 }}>
        <View style={[styles.row, { justifyContent: "space-between" }]}>
          <Text style={[styles.label, { color: c.text, flex: 1 }]} numberOfLines={1}>
            {bot.configuration?.name}
          </Text>
          <Text style={[styles.caption, { color: c.muted }]}>{age(bot.lastMessage?.createdAt?.seconds)}</Text>
        </View>
        <Text numberOfLines={1} style={[styles.meta, { color: c.muted }]}>
          {bot.lastMessage?.text || "Start a conversation"}
        </Text>
      </View>
      {bot.unreadCount > 0 && <Text style={[styles.caption, { color: c.accent }]}>{bot.unreadCount}</Text>}
    </Pressable>
  );
}
