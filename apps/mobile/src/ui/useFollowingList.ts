import { useCallback, useRef, useState } from "react";
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
  // The scroll offset as of the last event, for the fold anchor (feed-anchor.tsx); 0 is the bottom.
  const offset = useRef(0);
  const following = useRef(true);
  const isFollowing = useCallback(() => following.current, []);

  function showLatest() {
    list.current?.scrollToOffset({ offset: 0, animated: true });
    offset.current = 0;
    following.current = true;
    setAtBottom(true);
  }

  function resumeFollowing() {
    list.current?.scrollToOffset({ offset: 0, animated: false });
    offset.current = 0;
    following.current = true;
    setAtBottom(true);
  }

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    offset.current = e.nativeEvent.contentOffset.y;
    following.current = offset.current <= FOLLOW_THRESHOLD;
    setAtBottom(following.current);
  }

  return {
    list,
    offset,
    isFollowing,
    atBottom,
    resumeFollowing,
    showLatest,
    listProps: {
      ref: list,
      inverted: true,
      onScroll,
      onScrollEndDrag: onScroll,
      onMomentumScrollEnd: onScroll,
      scrollEventThrottle: 32,
      // Offset 0 is the bottom: keep the visible rows still when content arrives, follow it near the bottom.
      maintainVisibleContentPosition: { minIndexForVisible: 0, autoscrollToTopThreshold: FOLLOW_THRESHOLD },
    },
  };
}
