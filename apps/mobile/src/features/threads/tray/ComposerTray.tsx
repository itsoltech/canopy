import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import Animated from "react-native-reanimated";
import { useMotion } from "../../../ui/motion";
import { useColors } from "../../../ui/theme";

/** The composer box's corner radius: the tray's sides meet its straight top edge. */
const INSET = 16;

/** FloatingComposer's padding above the box, which the tray covers to reach the box's top edge. */
export const TRAY_OVERLAP = 8;

/**
 * The panels attached above the composer (web: ComposerTop): goal, subagents, queue and requests in one stack on the
 * composer's surface, with only its top corners rounded; its bottom edge is the composer's top border. Each panel
 * draws a hairline above itself; the stack's own border covers the first one. Taller than its room, it scrolls.
 */
export function ComposerTray({ children }: { children: ReactNode }) {
  const c = useColors();
  const { rise } = useMotion();

  return (
    <Animated.View
      entering={rise.entering}
      exiting={rise.exiting}
      style={{
        flexShrink: 1,
        minHeight: 0,
        marginHorizontal: INSET,
        marginBottom: -TRAY_OVERLAP,
        paddingBottom: TRAY_OVERLAP,
        backgroundColor: c.surface,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        borderWidth: 1,
        borderBottomWidth: 0,
        borderColor: c.line,
        overflow: "hidden",
      }}
    >
      <ScrollView
        bounces={false}
        keyboardShouldPersistTaps="always"
        keyboardDismissMode="none"
        showsVerticalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 1 }}
      >
        <View style={{ marginTop: -1 }}>{children}</View>
      </ScrollView>
    </Animated.View>
  );
}

/** One panel of the tray: the hairline above it and its content. */
export function TrayPanel({ children }: { children: ReactNode }) {
  const c = useColors();

  return <View style={{ borderTopWidth: 1, borderColor: c.line }}>{children}</View>;
}
