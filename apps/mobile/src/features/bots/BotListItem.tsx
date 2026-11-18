import { Pressable, Text, View } from "react-native";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useLayout } from "../../state/layout";
import type { bots } from "@canopy/contracts";
import { BotAvatar } from "./BotAvatar";
import { formatAge } from "@canopy/domain/format";
import { font, styles, useColors } from "../../ui/theme";
import Animated from "react-native-reanimated";
import { useMotion } from "../../ui/motion";
import { Swap } from "../../ui/MotionViews";
import { useComputerHome } from "../computers/presence";
import { useState } from "react";
import { BotActions } from "./BotActions";
import { IconButton } from "../../ui/components";
import { useSidebarTypography } from "../navigation/sidebar-scale";

export function BotListItem({ bot }: { bot: bots.Bot }) {
  const c = useColors();
  const type = useSidebarTypography();
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
          gap: 12,
          borderRadius: 12,
          minHeight: 48,
          paddingHorizontal: 12,
          paddingVertical: 8,
          backgroundColor: pressed || active ? c.inset : "transparent",
          opacity: home.away ? 0.55 : 1,
        })}
      >
        <BotAvatar bot={bot} size={44} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={[styles.row, { alignItems: "baseline" }]}>
            <Text
              style={[type.title, { fontFamily: font.medium, color: c.text, flex: 1, minWidth: 0 }]}
              numberOfLines={1}
            >
              {bot.configuration?.name}
            </Text>
            <Text numberOfLines={1} style={[type.caption, { flexShrink: 0, color: c.muted }]}>
              {home.away ? "Read-only" : formatAge(bot.lastMessage?.createdAt)}
            </Text>
          </View>
          <View style={styles.row}>
            <Text numberOfLines={1} style={[type.meta, { flex: 1, minWidth: 0, color: c.muted }]}>
              {bot.lastMessage?.text || "Start a conversation"}
            </Text>
            {bot.unreadCount > 0 && (
              <Animated.View entering={pop.entering} exiting={pop.exiting} style={{ maxWidth: "60%" }}>
                <Swap value={String(bot.unreadCount)}>
                  <Text numberOfLines={1} style={[type.caption, { color: c.accent }]}>
                    {bot.unreadCount}
                  </Text>
                </Swap>
              </Animated.View>
            )}
          </View>
        </View>
        <IconButton icon="ellipsis-horizontal" label="Bot actions" onPress={() => setActions(true)} />
      </Pressable>
      <BotActions bot={bot} visible={actions} onClose={() => setActions(false)} />
    </>
  );
}
