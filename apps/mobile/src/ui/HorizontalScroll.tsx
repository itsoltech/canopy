import type { ReactNode } from "react";
import type { ScrollViewProps } from "react-native";
import { GestureHandlerRootView, ScrollView } from "react-native-gesture-handler";
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useColors } from "./theme";

const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);

/** Native horizontal arbitration inside a vertical feed, including blocks shown in a modal viewer. */
export function HorizontalScroll({
  children,
  contentContainerStyle,
  onLayout,
}: {
  children: ReactNode;
  contentContainerStyle?: ScrollViewProps["contentContainerStyle"];
  onLayout?: ScrollViewProps["onLayout"];
}) {
  const c = useColors();
  const frame = useSharedValue(0);
  const content = useSharedValue(0);
  const offset = useSharedValue(0);
  const scroll = useAnimatedScrollHandler((event) => offset.set(event.contentOffset.x));

  const edge = useAnimatedStyle(() => ({
    opacity: content.get() > frame.get() + 1 && offset.get() + frame.get() < content.get() - 1 ? 1 : 0,
  }));

  return (
    // A local root also works in Android Modal windows, outside the application's native view tree.
    <GestureHandlerRootView style={{ minWidth: 0, maxWidth: "100%" }}>
      <AnimatedScrollView
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        showsHorizontalScrollIndicator
        alwaysBounceHorizontal={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        style={{ flexGrow: 0 }}
        contentContainerStyle={contentContainerStyle}
        onLayout={(event) => {
          frame.set(event.nativeEvent.layout.width);
          onLayout?.(event);
        }}
        onContentSizeChange={(width) => content.set(width)}
        onScroll={scroll}
        scrollEventThrottle={16}
      >
        {children}
      </AnimatedScrollView>
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          {
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: 16,
            backgroundImage: `linear-gradient(to right, ${c.faint}00, ${c.faint}26)`,
          },
          edge,
        ]}
      />
    </GestureHandlerRootView>
  );
}
