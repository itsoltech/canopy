import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { LayoutChangeEvent, NativeScrollEvent } from "react-native";
import {
  useAnimatedScrollHandler,
  useComposedEventHandler,
  type ScrollHandlerProcessed,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { useFollowingList } from "../../ui/useFollowingList";
import type { ThreadCreation } from "./thread-creations";

// Both phases keep a header, a single prompt or turn cell, and the same native footer.
const firstTurnReadingAnchor = { minIndexForVisible: 2 };

/** Both versions of the first prompt start at the oldest edge of the inverted list. */
export function usePreparationAnchor<Item>(
  job: ThreadCreation | undefined,
  following: ReturnType<typeof useFollowingList<Item>>,
  scroll: ScrollHandlerProcessed,
  staging = true,
) {
  const dimensions = useRef({ content: 0, viewport: 0 });
  const frame = useRef(0);
  const latest = useRef({ job, following, staging });
  useLayoutEffect(() => {
    latest.current = { job, following, staging };
  });

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const align = useCallback((replay = false) => {
    const { job, following, staging } = latest.current;
    const anchor = job?.preparationAnchor;
    const { content, viewport } = dimensions.current;

    if (!anchor || !content || !viewport || (staging && !following.reader.idle())) return;
    const minimum = following.minimum.get();
    const oldest = Math.max(minimum, content - viewport);
    const offset = Math.max(minimum, oldest - anchor.fromOldest);
    anchor.distance = following.distance(offset);
    following.finishReading(offset, replay);
  }, []);

  const remember = useCallback((fromOldest: number, offset: number) => {
    const { job, following, staging } = latest.current;

    if (!job || !staging) return;
    job.preparationAnchor = following.isFollowing(offset)
      ? undefined
      : { fromOldest, distance: following.distance(offset) };
  }, []);

  const cancel = useCallback(() => {
    const { job } = latest.current;

    if (job) job.preparationAnchor = undefined;
  }, []);

  const record = useCallback(
    (event: NativeScrollEvent) => {
      "worklet";
      const offset = event.contentOffset.y;
      const fromOldest = Math.max(0, event.contentSize.height - event.layoutMeasurement.height - offset);
      scheduleOnRN(remember, fromOldest, offset);
    },
    [remember],
  );

  const capture = useAnimatedScrollHandler<{
    dragging?: boolean;
    flinging?: boolean;
    released?: number;
    last?: number;
  }>({
    onBeginDrag: (_event, gesture) => {
      gesture.dragging = true;
      gesture.flinging = false;
      gesture.released = undefined;
      gesture.last = 0;

      if (!staging) scheduleOnRN(cancel);
    },
    onScroll: (event, gesture) => {
      if (!staging || (!gesture.dragging && !gesture.flinging)) return;
      const now = Date.now();

      if (now - (gesture.last ?? 0) < 100) return;
      gesture.last = now;
      record(event);
    },
    onEndDrag: (event, gesture) => {
      gesture.dragging = false;
      gesture.released = Date.now();

      if (staging) record(event);
    },
    onMomentumBegin: (_event, gesture) => {
      gesture.flinging = Date.now() - (gesture.released ?? 0) < 300;
      gesture.released = undefined;
    },
    onMomentumEnd: (event, gesture) => {
      if (!gesture.flinging) return;
      gesture.flinging = false;

      if (staging) record(event);
    },
  });

  return {
    onTouchStart: job && !staging ? cancel : undefined,
    maintainVisibleContentPosition:
      job && !following.atBottom ? firstTurnReadingAnchor : following.listProps.maintainVisibleContentPosition,
    onLayout(event: LayoutChangeEvent) {
      dimensions.current.viewport = event.nativeEvent.layout.height;
      align();
    },
    onContentSizeChange(_width: number, height: number) {
      dimensions.current.content = height;
      align();

      if (!staging && job?.preparationAnchor) {
        // The first turn and its native scroll range can commit on separate frames.
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => align(true));
      }
    },
    onScroll: useComposedEventHandler([scroll, job ? capture : null]),
  };
}
