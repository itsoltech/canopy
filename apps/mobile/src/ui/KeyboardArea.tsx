import { useEffect, useState, type ReactNode } from "react";
import {
  Dimensions,
  Keyboard,
  LayoutAnimation,
  Platform,
  View,
  type KeyboardEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useReducedMotion } from "./motion";
import { ContentInsets, useContentInsets } from "./ScreenFrame";

/**
 * How far the keyboard reaches up from the window's bottom edge; 0 while it is hidden. The app runs edge-to-edge,
 * so the window never resizes and the keyboard's top (`screenY`) is measured in the window's own coordinates. On
 * Android the keyboard's `height` leaves out the navigation bar under it, so the overlap is taken from its top.
 */
export function useKeyboardOverlap() {
  const reduced = useReducedMotion();
  const [overlap, setOverlap] = useState(0);

  useEffect(() => {
    // iOS reports before the keyboard moves (the layout follows with its own timing); Android only after.
    const ios = Platform.OS === "ios";

    const follow = (event: KeyboardEvent, next: number) => {
      if (ios && !reduced && event.duration)
        LayoutAnimation.configureNext({
          duration: event.duration,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      setOverlap(next);
    };

    const subscriptions = [
      Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (event) =>
        follow(event, Math.max(0, Dimensions.get("window").height - event.endCoordinates.screenY)),
      ),
      Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", (event) => follow(event, 0)),
    ];

    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [reduced]);

  return overlap;
}

/**
 * The lower part of a full-height screen that holds a composer or a form: its bottom sits on the keyboard while it
 * is open (with no gap). With the keyboard closed, backgrounds and scrollers reach the screen bottom;
 * scroll-content and floating controls consume the bottom safe-area inset themselves.
 */
export function KeyboardArea({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const insets = useContentInsets();
  const overlap = useKeyboardOverlap();

  return (
    <ContentInsets.Provider value={{ ...insets, bottom: overlap ? 0 : insets.bottom }}>
      <View style={[{ flex: 1, paddingBottom: overlap }, style]}>{children}</View>
    </ContentInsets.Provider>
  );
}
