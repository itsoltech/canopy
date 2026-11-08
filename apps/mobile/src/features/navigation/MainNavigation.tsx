import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../../state/session";
import { useColors } from "../../ui/theme";
import { useLayout } from "../../state/layout";
import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, { LayoutAnimationConfig, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { AppSidebar } from "./AppSidebar";
import { motion, smoothOut, useReducedMotion } from "../../ui/motion";
import { PaneInsets } from "../../ui/ScreenFrame";

/** Wide windows keep the thread list beside the stack (collapsible); phones navigate list → thread. */
export default function MainNavigation() {
  const c = useColors();
  const { session } = useSession();
  const { wide, sidebarOpen, sidebarWidth } = useLayout();
  const insets = useSafeAreaInsets();
  const showSidebar = Boolean(session) && sidebarOpen;
  // Only the toggle animates; rotation, folding and sign-in switch at once.
  const context = `${wide}:${Boolean(session)}`;

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: c.background }}>
      <PaneInsets.Provider value={{ left: insets.left, right: 0 }}>
        <SidebarColumn key={context} open={showSidebar} width={sidebarWidth + insets.left} />
      </PaneInsets.Provider>
      <PaneInsets.Provider value={{ left: showSidebar ? 0 : insets.left, right: insets.right }}>
        <View style={{ flex: 1, overflow: "hidden" }}>
          <Screens />
        </View>
      </PaneInsets.Provider>
    </View>
  );
}

/**
 * Panel reveal (web `t-sidebar`): the list slides in from the window's edge and fades, opening on `slow` and closing
 * on `medium`. The column takes its width before the slide in and gives it up after the slide out, so the screen
 * beside it lays out once, never during the motion (a long thread re-wraps all its text, which would stall the
 * frames). Instant with reduced motion.
 */
function SidebarColumn({ open, width }: { open: boolean; width: number }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  // The column has laid out at its width: the slide may start.
  const [placed, setPlaced] = useState(open);
  const progress = useSharedValue(open ? 1 : 0);

  const panel = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateX: (progress.get() - 1) * width }],
  }));

  if (open && !mounted) setMounted(true);

  if (!mounted && placed) setPlaced(false);
  useEffect(() => {
    if (open && !placed) return;
    const duration = reduced ? 0 : open ? motion.slow : motion.medium;
    progress.set(
      withTiming(open ? 1 : 0, { duration, easing: smoothOut }, (finished) => {
        if (finished && !open) scheduleOnRN(setMounted, false);
      }),
    );
  }, [open, placed, reduced, progress]);

  if (!mounted) return null;

  return (
    <View onLayout={() => setPlaced(true)} style={{ width, overflow: "hidden" }}>
      <Animated.View
        pointerEvents={open ? "auto" : "none"}
        style={[{ flex: 1, width, borderRightWidth: 1, borderRightColor: c.line }, panel]}
      >
        <LayoutAnimationConfig skipEntering skipExiting>
          <AppSidebar />
        </LayoutAnimationConfig>
      </Animated.View>
    </View>
  );
}

/** Beside the sidebar screens swap in place: a slide would carry the old screen over the list. */
function Screens() {
  const c = useColors();
  const { wide } = useLayout();
  const reduced = useReducedMotion();

  return (
    <Stack
      // A screen's first render and its removal do not animate its rows and notices; later changes do.
      screenLayout={({ children }) => (
        <LayoutAnimationConfig skipEntering skipExiting>
          {children}
        </LayoutAnimationConfig>
      )}
      screenOptions={{
        animation: reduced || wide ? "none" : "default",
        headerShown: false,
        headerStyle: { backgroundColor: c.background },
        headerTintColor: c.text,
        contentStyle: { backgroundColor: c.background },
        headerShadowVisible: false,
      }}
    />
  );
}
