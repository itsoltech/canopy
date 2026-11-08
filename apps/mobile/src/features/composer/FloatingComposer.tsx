import type { ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useKeyboardFrame } from "../../ui/KeyboardWindow";
import { useMotion } from "../../ui/motion";
import { useColors } from "../../ui/theme";
import { IconButton } from "../../ui/components";
import { useContentInsets } from "../../ui/ScreenFrame";
import { ComposerMotionContext, type ComposerMotion } from "./ComposerFold";

/** Web VirtualFeed's bottom overlay: canvas fading over 32 points, with the timeline continuing underneath. */
export function FloatingComposer({
  children,
  onLayout,
  onExpand,
  onLatest,
  motion,
  overlay,
  accessory,
}: {
  children: ReactNode;
  /** Popovers never participate in the measured composer or the feed's reserve. */
  overlay?: ReactNode;
  /** Status rows float outside the input measurement; empty slots never enlarge the fade or feed reserve. */
  accessory?: ReactNode;
  /** The fold and writing motion its composer parts follow (useFloatingComposer). */
  motion: ComposerMotion;
  onLayout: (event: LayoutChangeEvent) => void;
  onExpand: () => void;
  onLatest?: (() => void) | undefined;
}) {
  const c = useColors();
  const insets = useContentInsets();
  const { pop } = useMotion();
  const keyboard = useKeyboardFrame();

  // Keep the overlay's top below the fixed header as its bottom follows the keyboard. The safe-area padding
  // sits outside the measured composer; its proportional sticky offset cancels it without resizing the reserve.
  const bounds = useAnimatedStyle(() => ({
    top: insets.top - keyboard.height.get() - insets.bottom * keyboard.progress.get(),
    transform: [{ translateY: keyboard.height.get() + insets.bottom * keyboard.progress.get() }],
  }));

  return (
    <ComposerMotionContext.Provider value={motion}>
      <Animated.View
        pointerEvents="box-none"
        style={[{ position: "absolute", bottom: 0, left: 0, right: 0, justifyContent: "flex-end" }, bounds]}
      >
        {onLatest && (
          // It pops in and out above the composer (web `pop`) without moving it.
          <Animated.View
            entering={pop.entering}
            exiting={pop.exiting}
            pointerEvents="box-none"
            style={{ height: 56, flexShrink: 1, alignItems: "center" }}
          >
            <View
              style={{
                borderRadius: 22,
                backgroundColor: c.surface,
                borderWidth: 1,
                borderColor: c.line,
                boxShadow: "0px 2px 8px #0000001a",
              }}
            >
              <IconButton icon="arrow-down" label="Show latest messages" onPress={onLatest} />
            </View>
          </Animated.View>
        )}
        <View
          pointerEvents="box-none"
          style={{
            zIndex: 1,
            flexShrink: 1,
            minHeight: 0,
            marginLeft: 12 + insets.left,
            marginRight: 12 + insets.right,
          }}
        >
          {overlay}
          {accessory && <View style={{ backgroundColor: c.background, borderRadius: 8 }}>{accessory}</View>}
        </View>
        <View style={{ paddingBottom: insets.bottom, backgroundColor: c.background }}>
          <View
            onLayout={onLayout}
            onTouchStart={onExpand}
            style={{
              flexShrink: 0,
              paddingLeft: 12 + insets.left,
              paddingRight: 12 + insets.right,
              paddingTop: 8,
              paddingBottom: 12,
              gap: 8,
              backgroundColor: c.background,
            }}
          >
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: -32,
                height: 32,
                left: 0,
                right: 0,
                backgroundImage: `linear-gradient(to bottom, ${c.background}00, ${c.background})`,
              }}
            />
            {children}
          </View>
        </View>
      </Animated.View>
    </ComposerMotionContext.Provider>
  );
}
