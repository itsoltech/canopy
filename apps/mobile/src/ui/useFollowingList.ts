import { useCallback, useState } from "react";
import { Platform, type FlatList, type FlatListProps } from "react-native";
import { useAnimatedRef, useAnimatedScrollHandler, useDerivedValue, useSharedValue } from "react-native-reanimated";
import { useKeyboardFrame } from "./KeyboardWindow";
import { useContentInsets } from "./ScreenFrame";
import { scheduleOnRN } from "react-native-worklets";

/** Within this distance of the latest message the list counts as at the bottom and keeps following. */
const FOLLOW_THRESHOLD = 96;

/**
 * Chat feeds render inverted: offset 0 is the latest message, so a thread opens at its end without a jump,
 * new messages stay in view while the reader is at the bottom, and the position holds while they read history.
 * The scroll position lives on the UI thread; React hears only when the reader leaves or reaches the bottom.
 * Pass `listProps` to a Reanimated list (`Animated.FlatList`, `TimelineList`).
 */
export function useFollowingList<Item>(keyboardChat = false) {
  const list = useAnimatedRef<FlatList<Item>>();
  const [atBottom, setAtBottom] = useState(true);
  const scrollY = useSharedValue(0);
  const corrections = useSharedValue(0);
  const bottom = useSharedValue(true);
  const anchoring = useSharedValue(false);
  const keyboard = useKeyboardFrame();
  const insets = useContentInsets();
  const ios = Platform.OS === "ios";

  // iOS exposes the chat inset as a negative offset; Android's synthetic inset keeps its end at zero.
  const minimum = useDerivedValue(() =>
    keyboardChat && ios
      ? Math.min(0, keyboard.height.get() + insets.bottom * keyboard.progress.get()) - insets.bottom
      : 0,
  );

  const distance = useCallback(
    (y: number) => {
      "worklet";

      return Math.max(0, y - minimum.get());
    },
    [minimum],
  );

  const isFollowing = useCallback(() => distance(scrollY.get()) <= FOLLOW_THRESHOLD, [scrollY, distance]);

  /** Records a scroll position (a worklet: scroll handlers call it on the UI thread). */
  const track = useCallback(
    (y: number) => {
      "worklet";
      scrollY.set(y);

      if (anchoring.get()) return;
      const at = distance(y) <= FOLLOW_THRESHOLD;

      if (at === bottom.get()) return;
      bottom.set(at);
      scheduleOnRN(setAtBottom, at);
    },
    [scrollY, bottom, distance, anchoring],
  );

  function jump(animated: boolean) {
    anchoring.set(false);
    corrections.set(corrections.get() + 1);
    const end = minimum.get();
    list.current?.scrollToOffset({ offset: end, animated });
    scrollY.set(end);
    bottom.set(true);
    setAtBottom(true);
  }

  const onScroll = useAnimatedScrollHandler({
    onBeginDrag: () => anchoring.set(false),
    onScroll: (event) => track(event.contentOffset.y),
    onMomentumEnd: (event) => track(event.contentOffset.y),
  });

  let anchor: FlatListProps<Item>["maintainVisibleContentPosition"] = {
    minIndexForVisible: 0,
    autoscrollToTopThreshold: FOLLOW_THRESHOLD,
  };

  // UIKit's autoscroll always targets zero, ignoring a negative keyboard inset. At the end an inverted list
  // follows naturally; enable native row anchoring only while reading history, without that autoscroll.
  if (keyboardChat && ios) anchor = atBottom ? undefined : { minIndexForVisible: 0 };

  return {
    list,
    scrollY,
    anchoring,
    isFollowing,
    atBottom,
    track,
    distance,
    minimum,
    corrections,
    resumeFollowing: () => jump(false),
    showLatest: () => jump(true),
    listProps: {
      ref: list,
      inverted: true,
      onScroll,
      scrollEventThrottle: 16,
      maintainVisibleContentPosition: anchor,
    },
  };
}
