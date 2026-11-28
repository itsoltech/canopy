import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type PressableProps } from "react-native";
import Animated from "react-native-reanimated";
import type { ui } from "@canopy/contracts";
import { firstLine } from "@canopy/domain/first-line";
import { IconButton } from "../../ui/Button";
import { Chevron } from "../../ui/MotionViews";
import { useAnchoredToggle } from "../../ui/feed-anchor";
import { styles, useTypography } from "../../ui/theme";
import { useTone } from "../../ui/tone";
import { BotSender, SenderDetails } from "./SenderLabel";
import { TimelineDisclosure } from "./TimelineDisclosure";
import { ThreadLink } from "./items/bus/ThreadLink";

export function AgentSteer({
  sourceId,
  sender,
  text,
  status,
  pending,
  icon,
  actions,
  onActions,
  children,
}: {
  sourceId: string;
  sender?: ui.AgentSender | undefined;
  text: string;
  status: string;
  pending: boolean;
  icon: ReactNode;
  actions: PressableProps;
  onActions?: (() => void) | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { header, toggle } = useAnchoredToggle();
  const type = useTypography();
  const violet = useTone("violet");
  const preview = firstLine(text).text || "Message from an agent";

  return (
    <View style={{ alignSelf: "flex-end", width: "100%", borderRadius: 8, backgroundColor: violet.panel.background }}>
      <Animated.View ref={header} collapsable={false}>
        <Pressable
          {...actions}
          accessibilityRole="button"
          accessibilityLabel={open ? "Collapse message" : `Expand message: ${preview}`}
          accessibilityState={{ expanded: open }}
          onPress={() => toggle(() => setOpen((value) => !value))}
          style={({ pressed }) => [
            StyleSheet.absoluteFill,
            { borderRadius: 8, backgroundColor: pressed ? violet.badge.background : undefined },
          ]}
        />
        <View
          pointerEvents="box-none"
          style={{ paddingHorizontal: 10, paddingVertical: 4, minHeight: 48, justifyContent: "center", gap: 2 }}
        >
          <View pointerEvents="box-none" style={[styles.row, { gap: 6 }]}>
            <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
              {icon}
            </View>
            <View pointerEvents="box-none" style={{ flex: 1, minWidth: 0, alignItems: "flex-start" }}>
              {sender?.botId ? (
                <BotSender verb="" botId={sender.botId} sender={sender} color={violet.text} />
              ) : sourceId ? (
                <ThreadLink threadId={sourceId} fallback={sender?.title || "Another thread"} />
              ) : (
                <Text pointerEvents="none" numberOfLines={1} style={[type.small, { color: violet.text }]}>
                  From an agent
                </Text>
              )}
            </View>
            <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
              <Chevron open={open} color={violet.text} size={14} />
            </View>
          </View>
          <View pointerEvents="none" style={{ gap: 2 }}>
            {open ? (
              <SenderDetails sender={sender} trailing={status} wrap />
            ) : (
              <Text accessible={false} numberOfLines={1} style={[type.small, { color: violet.panel.text }]}>
                {preview}
              </Text>
            )}
            {pending && !open ? (
              <Text accessibilityLiveRegion="polite" style={[type.meta, { color: violet.text }]}>
                {status}
              </Text>
            ) : null}
          </View>
        </View>
      </Animated.View>
      <TimelineDisclosure open={open} style={{ paddingHorizontal: 10, paddingBottom: 6, gap: 4 }}>
        {children}
        {onActions && (
          <IconButton
            label="Show message actions"
            icon="ellipsis-horizontal"
            size="sm"
            onPress={onActions}
            style={{ alignSelf: "flex-end" }}
          />
        )}
      </TimelineDisclosure>
    </View>
  );
}
