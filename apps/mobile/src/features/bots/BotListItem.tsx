import { Pressable, Text, View } from "react-native";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useAppearance } from "../../state/appearance";
import { useLayout } from "../../state/layout";
import type { bots } from "@canopy/contracts";
import { palette } from "@canopy/ui";
import { MarkdownSnippet } from "../../ui/markdown/MarkdownSnippet";
import { BotAvatar } from "./BotAvatar";
import { formatAge } from "@canopy/domain/format";
import { font, styles, useColors } from "../../ui/theme";
import Animated from "react-native-reanimated";
import { useMotion } from "../../ui/motion";
import { AnimatedNumber } from "../../ui/AnimatedNumber";
import { useComputerHome } from "../computers/presence";
import { useState } from "react";
import { BotActions } from "./BotActions";
import { IconButton } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { useSidebarTypography } from "../navigation/sidebar-scale";

export function BotListItem({ bot, activityLive }: { bot: bots.Bot; activityLive: boolean }) {
  const c = useColors("sidebar-list");
  const type = useSidebarTypography();
  const { threadsEnabled } = useAppearance();
  const [actions, setActions] = useState(false);
  const home = useComputerHome(bot.nodeId);
  const { pop } = useMotion();
  const layout = useLayout();
  const pathname = usePathname();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const active = layout.wide && pathname.startsWith("/bot/") && id === bot.id;
  const activityAvailable = activityLive && !home.away;
  const working = activityAvailable && !bot.archived && bot.executing;
  const delegated = activityAvailable ? bot.delegatedThreads : undefined;
  const threadSignal = delegatedThreadLabel(threadsEnabled && !bot.archived, delegated);

  const accessibilityLabel = [
    bot.configuration?.name ?? "Bot",
    home.away ? `Read-only, ${home.reason}` : "",
    working ? "Bot working" : "",
    threadSignal,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={bot.unreadCount ? { text: `${bot.unreadCount} unread` } : undefined}
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
        <View>
          <BotAvatar bot={bot} size={44} />
          {working && (
            <View
              pointerEvents="none"
              style={{ position: "absolute", bottom: -3, left: -8, right: -8, alignItems: "center" }}
            >
              <Text
                adjustsFontSizeToFit
                numberOfLines={1}
                style={[
                  type.caption,
                  {
                    borderRadius: 8,
                    overflow: "hidden",
                    paddingHorizontal: 4,
                    fontFamily: font.medium,
                    backgroundColor: c.dark ? palette.cyan[950] : palette.cyan[100],
                    color: c.dark ? palette.cyan[100] : palette.cyan[950],
                  },
                ]}
              >
                Working
              </Text>
            </View>
          )}
        </View>
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
              {bot.lastMessage?.text ? <MarkdownSnippet text={bot.lastMessage.text} /> : "Start a conversation"}
            </Text>
            {threadSignal ? <DelegatedThreadSignal label={threadSignal} known={!!delegated} /> : null}
            {bot.unreadCount > 0 && (
              <Animated.View entering={pop.entering} exiting={pop.exiting} style={{ maxWidth: "60%" }}>
                <AnimatedNumber
                  value={String(bot.unreadCount)}
                  amount={bot.unreadCount}
                  numberOfLines={1}
                  animateOnMount={false}
                  style={[type.caption, { color: c.accent }]}
                />
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

function delegatedThreadLabel(show: boolean, counts: bots.Bot["delegatedThreads"]): string {
  if (!show) return "";

  if (!counts) return "Threads unknown";
  const { working } = counts;

  return working ? `${working.toLocaleString()} ${working === 1 ? "thread" : "threads"} working` : "";
}

function DelegatedThreadSignal({ label, known }: { label: string; known: boolean }) {
  const c = useColors("sidebar-list");
  const type = useSidebarTypography();
  const color = known ? c.working.text : c.muted;

  return (
    <View style={[styles.row, { gap: 4, maxWidth: "78%", flexShrink: 1 }]}>
      <Icon name={known ? "document-duplicate" : "question-mark-circle"} size={12} color={color} />
      <Text style={[type.caption, { color, flexShrink: 1, textAlign: "right", fontVariant: ["tabular-nums"] }]}>
        {label}
      </Text>
    </View>
  );
}
