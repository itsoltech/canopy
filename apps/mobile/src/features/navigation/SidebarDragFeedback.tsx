import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Text, View } from "react-native";
import type { CellRendererProps } from "@react-native/virtualized-lists";
import Animated, { useAnimatedReaction, useAnimatedStyle } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { SidebarEntry } from "@canopy/domain/sidebar-entries";
import { styles, useColors } from "../../ui/theme";
import { useMotion } from "../../ui/motion";
import { useSidebarDragContext, type SidebarListEntry } from "./sidebar-drag";

/** Only mounted cells report geometry; the drag loop never measures the whole list. */
export function SidebarOrderCell({
  cellKey,
  children,
  onLayout,
  onFocusCapture,
  style,
}: CellRendererProps<SidebarListEntry>) {
  const drag = useSidebarDragContext();
  const { layout } = useMotion();
  const animated = useAnimatedStyle(() => ({ opacity: drag?.active.get() === cellKey ? 0.3 : 1 }));

  useEffect(
    () => () => {
      drag?.boxes.modify((boxes) => {
        "worklet";
        delete boxes[cellKey];

        return boxes;
      });
      drag?.pickups.modify((pickups) => {
        "worklet";
        delete pickups[cellKey];

        return pickups;
      });
    },
    [drag, cellKey],
  );

  return (
    <Animated.View
      layout={layout}
      style={[style, animated]}
      onFocusCapture={onFocusCapture}
      onLayout={(event) => {
        onLayout?.(event);
        const { y, height } = event.nativeEvent.layout;
        drag?.boxes.modify((boxes) => {
          "worklet";
          boxes[cellKey] = { top: y, height };

          return boxes;
        });
      }}
    >
      {children}
    </Animated.View>
  );
}

/** React updates this isolated overlay once at pickup; pointer frames stay on the UI thread. */
export function SidebarDragFeedback({ entries }: { entries: readonly SidebarEntry[] }) {
  const drag = useSidebarDragContext();
  const c = useColors();
  const latest = useRef(entries);
  latest.current = entries;
  const [title, setTitle] = useState("");

  const pickup = useCallback((id: string) => {
    setTitle(latest.current.find((entry) => entry.thread?.id === id)?.thread?.title || "Untitled thread");

    if (id) AccessibilityInfo.announceForAccessibility("Drag within this section, or to the top to pin.");
  }, []);

  useAnimatedReaction(
    () => drag?.active.get() ?? "",
    (id, previous) => {
      if (id !== previous && id) scheduleOnRN(pickup, id);
    },
  );

  const ghost = useAnimatedStyle(() => ({
    opacity: drag?.active.get() ? 1 : 0,
    transform: [{ translateY: (drag?.pointer.get() ?? 0) - Math.min(40, drag?.grab.get() ?? 0) }],
  }));

  const zone = useAnimatedStyle(() => ({
    opacity: drag?.active.get() ? 1 : 0,
    borderColor: drag?.pin.get() ? c.accent : c.rule,
  }));

  const hint = useAnimatedStyle(() => ({ opacity: drag?.pin.get() ? 0 : 1 }));
  const release = useAnimatedStyle(() => ({ opacity: drag?.pin.get() ? 1 : 0 }));

  const line = useAnimatedStyle(() => ({
    opacity: drag?.active.get() && !drag.pin.get() && drag.target.get().line >= 0 ? 1 : 0,
    transform: [{ translateY: (drag?.target.get().line ?? 0) - (drag?.offset.get() ?? 0) }],
  }));

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: "absolute", inset: 0, overflow: "hidden" }}
    >
      <Animated.View
        style={[
          {
            position: "absolute",
            top: 0,
            left: 8,
            right: 8,
            height: 48,
            borderWidth: 2,
            borderStyle: "dashed",
            borderRadius: 12,
            backgroundColor: c.surface,
            justifyContent: "center",
            alignItems: "center",
            zIndex: 2,
          },
          zone,
        ]}
      >
        <Animated.Text style={[styles.meta, { color: c.muted }, hint]}>Drop here to pin</Animated.Text>
        <Animated.Text style={[styles.meta, { position: "absolute", color: c.accent }, release]}>
          Release to pin
        </Animated.Text>
      </Animated.View>
      <Animated.View
        style={[
          {
            position: "absolute",
            top: 0,
            left: 8,
            right: 8,
            minHeight: 80,
            padding: 12,
            borderWidth: 1,
            borderColor: c.accent,
            backgroundColor: c.surface,
            borderRadius: 12,
            zIndex: 1,
          },
          ghost,
        ]}
      >
        <Text numberOfLines={2} style={[styles.body, { color: c.text }]}>
          {title}
        </Text>
      </Animated.View>
      <Animated.View
        style={[
          { position: "absolute", top: 0, left: 8, right: 8, height: 2, backgroundColor: c.accent, zIndex: 3 },
          line,
        ]}
      />
    </View>
  );
}
