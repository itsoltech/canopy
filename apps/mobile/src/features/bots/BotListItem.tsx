import { Pressable, Text, View } from "react-native";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useLayout } from "../../state/layout";
import type { bots } from "@canopy/contracts";
import { BotAvatar } from "./BotAvatar";
import { age } from "../navigation/SidebarThread";
import { font, styles, useColors } from "../../ui/theme";
import Animated from "react-native-reanimated";
import { useMotion } from "../../ui/motion";
import { Swap } from "../../ui/MotionViews";
import { useComputerHome } from "../computers/presence";
import { useState } from "react";
import { BotActions } from "./BotActions";
import { IconButton } from "../../ui/components";

export function BotListItem({ bot }: { bot: bots.Bot }) {
  const c = useColors();
  const [actions, setActions] = useState(false);
  const home = useComputerHome(bot.nodeId);
  const { pop } = useMotion();
  const layout = useLayout();
  const pathname = usePathname();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const active = layout.wide && pathname.startsWith("/bot/") && id === bot.id;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${bot.configuration?.name ?? "Bot"}${home.away ? `, Read-only, ${home.reason}` : ""}`}
        accessibilityState={{ selected: active }}
        onPress={() => layout.open({ pathname: "/bot/[id]", params: { id: bot.id } })}
        onLongPress={() => setActions(true)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          borderRadius: 12,
          minHeight: 48,
          paddingHorizontal: 12,
          paddingVertical: 6,
          backgroundColor: pressed || active ? c.inset : "transparent",
          opacity: home.away ? 0.55 : 1,
        })}
      >
        <BotAvatar bot={bot} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <View style={[styles.row, { justifyContent: "space-between" }]}>
            <Text
              style={[styles.chrome, { fontFamily: font.medium, color: c.text, flex: 1, minWidth: 0 }]}
              numberOfLines={1}
            >
              {bot.configuration?.name}
            </Text>
            <Text style={[styles.caption, { color: c.muted }]}>
              {home.away ? "Read-only" : age(bot.lastMessage?.createdAt?.seconds)}
            </Text>
          </View>
          <Text numberOfLines={1} style={[styles.chromeMeta, { color: c.muted }]}>
            {bot.lastMessage?.text || "Start a conversation"}
          </Text>
        </View>
        {/* The unread count pops in and swaps as it grows (web `pop`, `swap`). */}
        <View style={{ width: 28, alignItems: "flex-end" }}>
          {bot.unreadCount > 0 && (
            <Animated.View entering={pop.entering} exiting={pop.exiting}>
              <Swap value={String(bot.unreadCount)}>
                <Text style={[styles.caption, { color: c.accent }]}>{bot.unreadCount}</Text>
              </Swap>
            </Animated.View>
          )}
        </View>
        <IconButton icon="ellipsis-horizontal" label="Bot actions" onPress={() => setActions(true)} />
      </Pressable>
      <BotActions bot={bot} visible={actions} onClose={() => setActions(false)} />
    </>
  );
}
