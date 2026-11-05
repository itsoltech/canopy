import { useRef, useState } from "react";
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from "react-native";

/** Within this distance of the latest message the list counts as at the bottom and keeps following. */
const FOLLOW_THRESHOLD = 96;

/**
 * Chat feeds render inverted: offset 0 is the latest message, so a thread opens at its end without a jump,
 * new messages stay in view while the reader is at the bottom, and the position holds while they read history.
 */
export function useFollowingList<Item>() {
  const list = useRef<FlatList<Item>>(null);
  const [atBottom, setAtBottom] = useState(true);

  function showLatest() {
    list.current?.scrollToOffset({ offset: 0, animated: true });
    setAtBottom(true);
  }

  function resumeFollowing() {
    list.current?.scrollToOffset({ offset: 0, animated: false });
    setAtBottom(true);
  }

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    setAtBottom(e.nativeEvent.contentOffset.y <= FOLLOW_THRESHOLD);
  }

  return {
    list,
    atBottom,
    resumeFollowing,
    showLatest,
    listProps: {
      ref: list,
      inverted: true,
      onScroll,
      scrollEventThrottle: 100,
      // Offset 0 is the bottom: keep the visible rows still when content arrives, follow it near the bottom.
      maintainVisibleContentPosition: { minIndexForVisible: 0, autoscrollToTopThreshold: FOLLOW_THRESHOLD },
    },
  };
}
