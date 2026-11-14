import { useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { useKeyboardFrame } from "../../ui/KeyboardWindow";
import { useMotion } from "../../ui/motion";
import { useColors } from "../../ui/theme";
import { IconButton } from "../../ui/components";
import { useContentInsets } from "../../ui/ScreenFrame";
import { ComposerMotionContext, useComposerMotion, type ComposerMotion } from "./ComposerFold";
import { ComposerViewport } from "./ComposerViewport";
import { ComposerCoverage } from "./ComposerCoverage";

/** Canvas and a short proportional fade, with the timeline continuing underneath. */
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
  coverage,
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
  /** Whole stack coverage; its safe-area portion is already owned by the native scroll view. */
  coverage?: SharedValue<number>;
}) {
  const c = useColors();
  const insets = useContentInsets();
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
          <View
            pointerEvents="box-none"
            style={{ height: 0, zIndex: 2, marginLeft: 12 + insets.left, marginRight: 12 + insets.right }}
          >
            {overlay}
          </View>
          <ComposerCoverage value={coverage} fade={<Fade />} latest={onLatest && <LatestButton onPress={onLatest} />}>
            <View pointerEvents="box-none" style={{ zIndex: 1, flexShrink: 1, minHeight: 0 }}>
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
          </ComposerCoverage>
        </Animated.View>
      </ComposerViewport>
    </ComposerMotionContext.Provider>
  );
}

/** Outside the stack's clipping and reserve, on the composer's axis. */
function LatestButton({ onPress }: { onPress: () => void }) {
  const c = useColors();
  const insets = useContentInsets();
  const { pop } = useMotion();
  const { progress } = useComposerMotion();

  const position = useAnimatedStyle(() => ({ marginBottom: 24 + 16 * progress.get() }));

  return (
    <Animated.View
      entering={pop.entering}
      exiting={pop.exiting}
      pointerEvents="box-none"
      style={[
        {
          position: "absolute",
          bottom: "100%",
          left: insets.left,
          right: insets.right,
          alignItems: "center",
          zIndex: 3,
        },
        position,
      ]}
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
        <IconButton icon="arrow-down" label="Show latest messages" onPress={onPress} />
      </View>
    </Animated.View>
  );
}

/** The same fade in both states: 16 points compact, 32 expanded. */
function Fade() {
  const c = useColors();
  const { progress } = useComposerMotion();

  const size = useAnimatedStyle(() => ({
    top: -(16 + 16 * progress.get()),
    height: 16 + 16 * progress.get(),
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          left: 0,
          right: 0,
          backgroundImage: `linear-gradient(to bottom, ${c.background}00, ${c.background})`,
        },
        size,
      ]}
    />
  );
}
