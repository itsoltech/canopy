import { useCallback } from "react";
import { useAnimatedScrollHandler, useSharedValue, type SharedValue } from "react-native-reanimated";
import { useKeyboardMotion } from "./useKeyboardMotion";
import type { useFollowingList } from "../../ui/useFollowingList";

// Match web's ComposerCompaction and FEED_END_THRESHOLD, in native layout points.
const END_DISTANCE = 8;
const COMPACT_DISTANCE = 192;
const COMPACT_TRAVEL = 96;

/** One fold decision per reader gesture; layout, keyboard and explicit scroll corrections consume its intent. */
export function useComposerScroll<Item>(
  following: ReturnType<typeof useFollowingList<Item>>,
  moving: SharedValue<boolean>,
  guarded: SharedValue<boolean>,
  fold: (compact: boolean) => boolean,
) {
  const reader = useSharedValue(false);
  const travel = useSharedValue(0);
  const returning = useSharedValue(0);
  const previous = useSharedValue(0);
  const content = useSharedValue(0);
  const viewport = useSharedValue(0);
  const correction = useSharedValue(0);
  const inset = useSharedValue(0);
  const { track, reader: gesture, distance, minimum, corrections } = following;
  const keyboardMoving = useKeyboardMotion(reader, travel);

  const reset = useCallback(() => {
    "worklet";
    reader.set(false);
    travel.set(0);
    returning.set(0);
  }, [reader, travel, returning]);

  const onScroll = useAnimatedScrollHandler({
    onBeginDrag: (event) => {
      gesture.begin();
      reader.set(!moving.get() && !keyboardMoving.get());
      travel.set(0);
      returning.set(0);
      previous.set(distance(event.contentOffset.y));
      content.set(event.contentSize.height);
      viewport.set(event.layoutMeasurement.height);
      correction.set(corrections.get());
      inset.set(minimum.get());
    },
    // Only the finger can change the composer; taps that stop momentum cannot inherit an old drag.
    onEndDrag: () => {
      gesture.end();
      reset();
    },
    onMomentumBegin: gesture.momentum,
    onMomentumEnd: (event) => {
      reset();
      track(event.contentOffset.y);
      gesture.end();

      // A fling that lands at the end opens the composer, as a drag back there does (web: a reader at the end).
      if (distance(event.contentOffset.y) <= END_DISTANCE) fold(false);
    },
    onScroll: (event) => {
      const fromEnd = distance(event.contentOffset.y);
      const up = fromEnd - previous.get();
      previous.set(fromEnd);
      track(event.contentOffset.y);

      if (
        moving.get() ||
        keyboardMoving.get() ||
        content.get() !== event.contentSize.height ||
        viewport.get() !== event.layoutMeasurement.height ||
        correction.get() !== corrections.get() ||
        inset.get() !== minimum.get()
      )
        return reset();

      if (!reader.get()) return;

      returning.set(Math.max(0, returning.get() - up));

      if (fromEnd <= END_DISTANCE && returning.get() >= 24) {
        if (fold(false)) reset();

        return;
      }

      if (guarded.get()) return;
      travel.set(Math.max(0, travel.get() + up));

      if (fromEnd >= COMPACT_DISTANCE && travel.get() >= COMPACT_TRAVEL) {
        reset();
        fold(true);
      }
    },
  });

  return { onScroll, reset };
}
