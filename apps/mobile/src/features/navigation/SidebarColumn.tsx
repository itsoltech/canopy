import { useLayoutEffect, useState } from "react";
import { StyleSheet, useWindowDimensions } from "react-native";
import Animated, {
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { maxSidebarWidth } from "@canopy/domain";
import { useDevicePreferences } from "../settings/device-preferences";
import { PaneInsets } from "../../ui/ScreenFrame";
import { motion, smoothOut, useReducedMotion } from "../../ui/motion";
import { useColors } from "../../ui/theme";
import { VisibilityScope } from "../../ui/viewport";
import { AppSidebar } from "./AppSidebar";
import { SidebarResizeHandle } from "./SidebarResizeHandle";

// The compact sidebar footer still needs room for its actions and connection status.
const MIN_WIDTH = 260;

/** The panel keeps its width while the split moves, so the list slides out without wrapping its rows. */
export function SidebarColumn({
  open,
  leftInset,
  rightInset,
}: {
  open: boolean;
  leftInset: number;
  rightInset: number;
}) {
  const c = useColors();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const device = useDevicePreferences();
  const max = Math.max(MIN_WIDTH, maxSidebarWidth(width - leftInset - rightInset));
  const defaultWidth = Math.round(Math.min(320, width * 0.36));
  const preferred = Math.max(MIN_WIDTH, Math.min(max, device.view.sidebarWidth || defaultWidth));
  const size = useSharedValue(preferred);
  const progress = useSharedValue(open ? 1 : 0);
  const [mounted, setMounted] = useState(open);

  if (open && !mounted) setMounted(true);

  useLayoutEffect(() => {
    size.set(preferred);
  }, [open, preferred, size]);

  useLayoutEffect(() => {
    let current = true;

    const finishClose = () => {
      if (current) setMounted(false);
    };

    progress.set(
      withTiming(
        open ? 1 : 0,
        {
          duration: reduced ? 0 : open ? motion.slow : motion.medium,
          easing: smoothOut,
          reduceMotion: ReduceMotion.Never,
        },
        (finished) => {
          if (finished && !open) scheduleOnRN(finishClose);
        },
      ),
    );

    return () => {
      current = false;
    };
  }, [open, progress, reduced]);

  // Keep the outside safe-area gutter in the split when closed so the conversation never jumps across it.
  const edge = useDerivedValue(() => leftInset + size.get() * progress.get());
  const column = useAnimatedStyle(() => ({ width: edge.get() }));
  const panel = useAnimatedStyle(() => ({ width: leftInset + size.get(), opacity: progress.get() }));

  return (
    <>
      <Animated.View style={[styles.column, column]}>
        {mounted && (
          <Animated.View
            pointerEvents={open ? "auto" : "none"}
            accessibilityElementsHidden={!open}
            importantForAccessibility={open ? "auto" : "no-hide-descendants"}
            style={[styles.panel, { backgroundColor: c.sidebar, borderRightColor: c.line }, panel]}
          >
            <PaneInsets.Provider value={{ left: leftInset, right: 0 }}>
              <LayoutAnimationConfig skipEntering skipExiting>
                <VisibilityScope visible={open}>
                  <AppSidebar />
                </VisibilityScope>
              </LayoutAnimationConfig>
            </PaneInsets.Provider>
          </Animated.View>
        )}
      </Animated.View>
      {open && device.viewLoaded && max > MIN_WIDTH && (
        <SidebarResizeHandle
          edge={edge}
          size={size}
          value={preferred}
          min={MIN_WIDTH}
          max={max}
          onResize={(sidebarWidth) => device.setView({ sidebarWidth })}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  column: { flexShrink: 0, overflow: "hidden" },
  panel: { position: "absolute", top: 0, bottom: 0, right: 0, borderRightWidth: StyleSheet.hairlineWidth },
});
