import { useCallback, useMemo, useRef, useState } from "react";
import type { FlatList } from "react-native";
import { useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

/** Within this distance of the latest message the list counts as at the bottom and keeps following. */
const FOLLOW_THRESHOLD = 96;

/**
 * Chat feeds render inverted: offset 0 is the latest message, so a thread opens at its end without a jump,
 * new messages stay in view while the reader is at the bottom, and the position holds while they read history.
 * The scroll position lives on the UI thread; React hears only when the reader leaves or reaches the bottom.
 * Pass `listProps` to a Reanimated list (`Animated.FlatList`, `TimelineList`).
 */
export function useFollowingList<Item>() {
  const list = useRef<FlatList<Item>>(null);
  const [atBottom, setAtBottom] = useState(true);
  const scrollY = useSharedValue(0);
  const bottom = useSharedValue(true);

  // The scroll offset for the fold anchor (feed-anchor.tsx); 0 is the bottom. Reads and writes go to the UI thread.
  const offset = useMemo(
    () => ({
      get current() {
        return scrollY.get();
      },
      set current(value: number) {
        scrollY.set(value);
      },
    }),
    [scrollY],
  );

  const isFollowing = useCallback(() => scrollY.get() <= FOLLOW_THRESHOLD, [scrollY]);

  /** Records a scroll position (a worklet: scroll handlers call it on the UI thread). */
  const track = useCallback(
    (y: number) => {
      "worklet";
      scrollY.set(y);
      const at = y <= FOLLOW_THRESHOLD;

      if (at === bottom.get()) return;
      bottom.set(at);
      scheduleOnRN(setAtBottom, at);
    },
    [scrollY, bottom],
  );

  function jump(animated: boolean) {
    list.current?.scrollToOffset({ offset: 0, animated });
    scrollY.set(0);
    bottom.set(true);
    setAtBottom(true);
  }

  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => track(event.contentOffset.y),
    onMomentumEnd: (event) => track(event.contentOffset.y),
  });

  return {
    list,
    offset,
    isFollowing,
    atBottom,
    track,
    resumeFollowing: () => jump(false),
    showLatest: () => jump(true),
    listProps: {
      ref: list,
      inverted: true,
      onScroll,
      scrollEventThrottle: 16,
      // Offset 0 is the bottom: keep the visible rows still when content arrives, follow it near the bottom.
      maintainVisibleContentPosition: { minIndexForVisible: 0, autoscrollToTopThreshold: FOLLOW_THRESHOLD },
    },
  };
}
