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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion } from "./motion";

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
 * is open (with no gap) and keeps the bottom safe-area inset while it is closed. Use it inside a SafeAreaView that
 * leaves out the bottom edge.
 */
export function KeyboardArea({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const insets = useSafeAreaInsets();
  const overlap = useKeyboardOverlap();

  return <View style={[{ flex: 1, paddingBottom: Math.max(overlap, insets.bottom) }, style]}>{children}</View>;
}
