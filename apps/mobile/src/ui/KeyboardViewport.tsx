import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { useKeyboardFrame } from "./KeyboardWindow";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { ContentInsets, useContentInsets } from "./ScreenFrame";

/** Forms follow native IME frames; their bottom safe area is consumed here, once. */
export function KeyboardViewport({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const insets = useContentInsets();
  const { height } = useKeyboardFrame();
  const keyboard = useAnimatedStyle(() => ({ paddingBottom: Math.max(-height.get(), insets.bottom) }));

  return (
    <ContentInsets.Provider value={{ ...insets, bottom: 0 }}>
      <Animated.View style={[{ flex: 1 }, style, keyboard]}>{children}</Animated.View>
    </ContentInsets.Provider>
  );
}
