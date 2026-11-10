import { useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useKeyboardFrame } from "../../ui/KeyboardWindow";
import { useMotion } from "../../ui/motion";
import { useColors } from "../../ui/theme";
import { IconButton } from "../../ui/components";
import { useContentInsets } from "../../ui/ScreenFrame";
import { ComposerMotionContext, type ComposerMotion } from "./ComposerFold";
import { ComposerViewport } from "./ComposerViewport";

/** Web VirtualFeed's bottom overlay: canvas fading over 32 points, with the timeline continuing underneath. */
export function FloatingComposer({
  children,
  onLayout,
  onExpand,
  onLatest,
  motion,
  overlay,
  accessory,
  tray,
  onAccessoryLayout,
}: {
  children: ReactNode;
  /** Popovers never participate in the measured composer or the feed's reserve. */
  overlay?: ReactNode;
  /** Status rows float outside the input measurement; empty slots never enlarge the fade or feed reserve. */
  accessory?: ReactNode;
  /** The panels attached to the composer's top edge (ComposerTray), under the status rows. */
  tray?: ReactNode;
  /** The height the status rows and the tray take above the composer, for the feed's reserve. */
  onAccessoryLayout?: (height: number) => void;
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
  const [block, setBlock] = useState(0);

  // Keep the overlay's top below the fixed header as its bottom follows the keyboard. The safe-area padding
  // sits outside the measured composer; its proportional sticky offset cancels it without resizing the reserve.
  const bounds = useAnimatedStyle(() => ({
    top: insets.top - keyboard.height.get() - insets.bottom * keyboard.progress.get(),
    transform: [{ translateY: keyboard.height.get() + insets.bottom * keyboard.progress.get() }],
  }));

  return (
    <ComposerMotionContext.Provider value={motion}>
      <ComposerViewport>
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
          <View pointerEvents="box-none" style={{ zIndex: 1, flexShrink: 1, minHeight: 0 }}>
            <View
              pointerEvents="box-none"
              style={{ flexShrink: 1, minHeight: 0, marginLeft: 12 + insets.left, marginRight: 12 + insets.right }}
            >
              {overlay}
            </View>
            {/* Status rows and the tray share the composer's canvas and fade, so the feed passes under them. */}
            <View
              pointerEvents="box-none"
              onLayout={(event) => {
                setBlock(event.nativeEvent.layout.height);
                onAccessoryLayout?.(event.nativeEvent.layout.height);
              }}
              style={{
                flexShrink: 1,
                minHeight: 0,
                gap: 8,
                paddingLeft: 12 + insets.left,
                paddingRight: 12 + insets.right,
                backgroundColor: block > 0 ? c.background : undefined,
              }}
            >
              {block > 0 && <Fade />}
              {accessory}
              {tray}
            </View>
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
              <Fade />
              {children}
            </View>
          </View>
        </Animated.View>
      </ComposerViewport>
    </ComposerMotionContext.Provider>
  );
}

/** The canvas fading over 32 points above whatever floats on top of the feed. */
function Fade() {
  const c = useColors();

  return (
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
  );
}
