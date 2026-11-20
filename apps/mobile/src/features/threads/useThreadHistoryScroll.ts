import { useCallback, useLayoutEffect, useRef } from "react";
import {
  useAnimatedScrollHandler,
  useComposedEventHandler,
  type ScrollHandlerProcessed,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

/** On an inverted list, dragging or flinging toward older messages increases the offset. */
export function useThreadHistoryScroll(scroll: ScrollHandlerProcessed, load: () => void) {
  const latest = useRef(load);
  useLayoutEffect(() => {
    latest.current = load;
  }, [load]);
  const request = useCallback(() => latest.current(), []);

  const history = useAnimatedScrollHandler<{ origin?: number; moving?: boolean }>({
    onBeginDrag(event, gesture) {
      gesture.origin = event.contentOffset.y;
      gesture.moving = true;
    },
    onEndDrag(_event, gesture) {
      gesture.moving = false;
    },
    onMomentumBegin(_event, gesture) {
      gesture.moving = true;
    },
    onMomentumEnd(_event, gesture) {
      gesture.origin = undefined;
      gesture.moving = false;
    },
    onScroll(event, gesture) {
      if (!gesture.moving || gesture.origin === undefined || event.contentOffset.y <= gesture.origin) return;
      const viewport = event.layoutMeasurement.height;
      const remaining = event.contentSize.height - viewport - event.contentOffset.y;

      if (remaining > 0.3 * viewport) return;
      gesture.origin = undefined;
      scheduleOnRN(request);
    },
  });

  return useComposedEventHandler([scroll, history]);
}
