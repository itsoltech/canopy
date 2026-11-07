import { Pressable, Text, View } from "react-native";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useLayout } from "../../state/layout";
import type { bots } from "@canopy/contracts";
import { BotAvatar } from "./BotAvatar";
import { age } from "../navigation/SidebarThread";
import { styles, useColors } from "../../ui/theme";
import Animated from "react-native-reanimated";
import { useMotion } from "../../ui/motion";
import { Swap } from "../../ui/MotionViews";
import { useComputerHome } from "../computers/presence";

export function BotListItem({ bot }: { bot: bots.Bot }) {
  const c = useColors();
  const home = useComputerHome(bot.nodeId);
  const { pop } = useMotion();
  const layout = useLayout();
  const pathname = usePathname();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const active = layout.wide && pathname.startsWith("/bot/") && id === bot.id;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${bot.configuration?.name ?? "Bot"}${home.away ? `, Read-only, ${home.reason}` : ""}`}
      accessibilityState={{ selected: active }}
      onPress={() => layout.open({ pathname: "/bot/[id]", params: { id: bot.id } })}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        borderRadius: 12,
        padding: 12,
        backgroundColor: pressed || active ? c.inset : "transparent",
        opacity: home.away ? 0.55 : 1,
      })}
    >
      <BotAvatar bot={bot} />
      <View style={{ flex: 1, gap: 4 }}>
        <View style={[styles.row, { justifyContent: "space-between" }]}>
          <Text style={[styles.label, { color: c.text, flex: 1 }]} numberOfLines={1}>
            {bot.configuration?.name}
          </Text>
          <Text style={[styles.caption, { color: c.muted }]}>
            {home.away ? "Read-only" : age(bot.lastMessage?.createdAt?.seconds)}
          </Text>
        </View>
        <Text numberOfLines={1} style={[styles.meta, { color: c.muted }]}>
          {bot.lastMessage?.text || "Start a conversation"}
        </Text>
      </View>
      {/* The unread count pops in and swaps as it grows (web `pop`, `swap`). */}
      {bot.unreadCount > 0 && (
        <Animated.View entering={pop.entering} exiting={pop.exiting}>
          <Swap value={String(bot.unreadCount)}>
            <Text style={[styles.caption, { color: c.accent }]}>{bot.unreadCount}</Text>
          </Swap>
        </Animated.View>
      )}
    </Pressable>
  );
}
