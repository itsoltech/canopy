import { useRef, useState } from "react";
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from "react-native";

export function useFollowingList<Item>() {
  const list = useRef<FlatList<Item>>(null);
  const followLatest = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  function resumeFollowing() {
    followLatest.current = true;
    setAtBottom(true);
  }

  function showLatest() {
    followLatest.current = true;
    list.current?.scrollToEnd({ animated: true });
    setAtBottom(true);
  }

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const bottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 100;

    if (bottom) followLatest.current = true;
    setAtBottom(bottom);
  }

  function onScrollBeginDrag() {
    followLatest.current = false;
  }

  function onContentSizeChange() {
    if (followLatest.current) list.current?.scrollToEnd({ animated: false });
  }

  return { list, atBottom, resumeFollowing, showLatest, onScroll, onScrollBeginDrag, onContentSizeChange };
}
