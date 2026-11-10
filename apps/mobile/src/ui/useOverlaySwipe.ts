import { useMemo, useRef } from "react";
import {
  PanResponder,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PanResponderGestureState,
  type LayoutChangeEvent,
  type GestureResponderEvent,
} from "react-native";
import { shouldDismissSheet } from "./sheet-gesture";

/** A downward swipe closes the overlay; a scrolled list first returns to its top. Never dismiss the keyboard. */
export function useOverlaySwipe(onClose: () => void) {
  const offset = useRef(0);
  const height = useRef(0);

  const gestures = useMemo(() => {
    const downward = (g: PanResponderGestureState) => g.dy > 8 && g.dy > Math.abs(g.dx) * 1.5;

    const finish = (_: GestureResponderEvent, g: PanResponderGestureState) => {
      if (shouldDismissSheet(g.dy, height.current, g.vy * 1000)) onClose();
    };

    const responder = (scroll: boolean) =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_, g) => (!scroll || offset.current <= 0) && downward(g),
        onPanResponderRelease: finish,
        onPanResponderTerminationRequest: () => false,
      }).panHandlers;

    return { handlers: responder(false), scrollHandlers: responder(true) };
  }, [onClose]);

  return {
    ...gestures,
    measure: (event: LayoutChangeEvent) => {
      height.current = event.nativeEvent.layout.height;
    },
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      offset.current = event.nativeEvent.contentOffset.y;
    },
  };
}
