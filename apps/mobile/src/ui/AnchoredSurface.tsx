import { useEffect, useRef, useState, type ComponentRef } from "react";
import { AccessibilityInfo, BackHandler, Keyboard, Pressable, ScrollView, Text, View } from "react-native";
import Animated, {
  measure,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type AnimatedRef,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { EdgeInsets } from "react-native-safe-area-context";
import type { AnchoredContent } from "./AnchoredOverlay";
import { useKeyboardFrame } from "./KeyboardWindow";
import { useMotion } from "./motion";
import { useDisclosureMotion } from "./disclosure-motion";
import { useOverlaySwipe } from "./useOverlaySwipe";
import { IconButton } from "./Button";
import { styles, useColors } from "./theme";

/** Measure on the UI thread so the portal follows scrolling, folding, rotation and every native keyboard frame. */
function useAnchorBounds(content: AnchoredContent, host: AnimatedRef<ComponentRef<typeof View>>, insets: EdgeInsets) {
  const keyboard = useKeyboardFrame();
  const { anchor: anchorRef, maxHeight } = content;
  const bounds = useSharedValue({ left: 0, bottom: 0, width: 0, maxHeight: 0 });
  const [positioned, setPositioned] = useState(false);

  useFrameCallback(() => {
    const frame = measure(host);
    const anchor = measure(anchorRef);

    if (!frame || !anchor) return;
    const edge = Math.min(anchor.pageY - frame.pageY, frame.height + keyboard.height.get() - insets.bottom);
    const left = Math.max(insets.left + 8, anchor.pageX - frame.pageX);

    const next = {
      left,
      bottom: frame.height - edge + 4,
      width: Math.max(0, Math.min(anchor.width, frame.width - insets.right - 8 - left)),
      maxHeight: Math.max(0, Math.min(maxHeight, (frame.height + keyboard.height.get()) * 0.4, edge - insets.top - 8)),
    };

    const previous = bounds.get();

    if ((!previous.width || !previous.maxHeight) && next.width && next.maxHeight) scheduleOnRN(setPositioned, true);

    if (
      next.left !== previous.left ||
      next.bottom !== previous.bottom ||
      next.width !== previous.width ||
      next.maxHeight !== previous.maxHeight
    )
      bounds.set(next);
  });

  return { style: useAnimatedStyle(() => bounds.get()), positioned };
}

/** Elevated, opaque, content-sized list. Its backdrop consumes outside taps without forwarding them to the feed. */
export function AnchoredSurface({
  content,
  host,
  insets,
}: {
  content: AnchoredContent;
  host: AnimatedRef<ComponentRef<typeof View>>;
  insets: EdgeInsets;
}) {
  const c = useColors();
  const { dropdown } = useMotion();
  const disclosure = useDisclosureMotion();
  const bounds = useAnchorBounds(content, host, insets);
  const swipe = useOverlaySwipe(content.onClose);
  const heading = useRef<ComponentRef<typeof Text>>(null);
  const focused = useRef(false);

  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      content.onClose();

      return true;
    });

    // Android can consume Back in the IME before BackHandler sees it.
    const hidden = Keyboard.addListener("keyboardDidHide", content.onClose);

    return () => {
      back.remove();
      hidden.remove();
    };
  }, [content.onClose]);

  // The first UI-thread measurement supplies the width and height limit before a height entrance starts.
  if (content.disclosure && !bounds.positioned) return null;

  return (
    <View collapsable={false} pointerEvents="box-none" style={{ position: "absolute", inset: 0 }}>
      <Pressable
        accessible={false}
        onPress={content.onClose}
        style={{ position: "absolute", inset: 0 }}
        {...swipe.handlers}
      />
      <Animated.View
        entering={content.disclosure ? disclosure.entering : dropdown.entering}
        exiting={content.disclosure ? disclosure.exiting : dropdown.exiting}
        layout={content.disclosure ? disclosure.layout : undefined}
        accessibilityViewIsModal={content.modal}
        accessibilityLabel={content.label}
        onAccessibilityEscape={content.onClose}
        onLayout={(event) => {
          swipe.measure(event);

          if (!content.modal || focused.current || !event.nativeEvent.layout.width) return;
          focused.current = true;

          if (heading.current) AccessibilityInfo.sendAccessibilityEvent(heading.current, "focus");
        }}
        style={[
          {
            position: "absolute",
            transformOrigin: "bottom center",
            borderRadius: 16,
            borderWidth: 1,
            borderColor: c.line,
            backgroundColor: c.overlay,
            boxShadow: "0px 4px 16px #00000026",
            overflow: "hidden",
          },
          bounds.style,
        ]}
      >
        <View {...swipe.handlers} style={[styles.row, { paddingLeft: 12, paddingRight: 4, minHeight: 40 }]}>
          <Text
            ref={heading}
            accessibilityRole="header"
            numberOfLines={1}
            style={[styles.overlayHeading, { color: c.muted, flex: 1 }]}
          >
            {content.label}
          </Text>
          <IconButton
            icon="x-mark"
            label={`Close ${content.label.toLowerCase()}`}
            size="sm"
            onPress={content.onClose}
          />
        </View>
        <ScrollView
          bounces={false}
          nestedScrollEnabled
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="none"
          showsVerticalScrollIndicator
          onScroll={swipe.onScroll}
          scrollEventThrottle={16}
          {...swipe.scrollHandlers}
          style={{ flexGrow: 0, flexShrink: 1, minHeight: 0 }}
          contentContainerStyle={{ padding: 4, paddingRight: 12 }}
        >
          {content.children}
        </ScrollView>
      </Animated.View>
    </View>
  );
}
