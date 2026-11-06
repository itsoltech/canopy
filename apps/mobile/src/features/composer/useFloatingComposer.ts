import { useEffect, useRef, useState } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import type { useFollowingList } from "../../ui/useFollowingList";

// Match web's ComposerCompaction and FEED_END_THRESHOLD, in native layout points.
const END_DISTANCE = 8;
const COMPACT_DISTANCE = 192;
const COMPACT_TRAVEL = 96;

/** Reader gestures fold the composer; stream updates, keyboard changes and anchor corrections do not. */
export function useFloatingComposer<Item>(
  following: ReturnType<typeof useFollowingList<Item>>,
  protectedDraft = false,
) {
  const [compact, setCompact] = useState(false);
  const [height, setHeight] = useState(0);
  const travel = useRef(0);
  const readerUntil = useRef(0);
  const previous = useRef(0);
  const measured = useRef(0);

  // A question or draft arriving while folded expands permanently, until another reader gesture.
  if (protectedDraft && compact) setCompact(false);

  useEffect(() => {
    if (!protectedDraft) return;
    travel.current = 0;
    readerUntil.current = 0;
  }, [protectedDraft]);

  function expand() {
    travel.current = 0;
    readerUntil.current = 0;
    setCompact(false);
  }

  function scroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    following.listProps.onScroll(event);
    const distance = Math.max(0, event.nativeEvent.contentOffset.y);
    const up = distance - previous.current;
    previous.current = distance;

    if (distance <= END_DISTANCE) {
      setHeight(measured.current);

      return expand();
    }

    if (protectedDraft || performance.now() >= readerUntil.current) return;

    readerUntil.current = performance.now() + 250;
    travel.current = Math.max(0, travel.current + up);

    if (distance >= COMPACT_DISTANCE && travel.current >= COMPACT_TRAVEL) setCompact(true);
  }

  function measure(event: LayoutChangeEvent) {
    const next = event.nativeEvent.layout.height;
    measured.current = next;
    // Like VirtualFeed.reservedFooter, retain space while reading history. Folding cannot move a message.
    // At the end, follow every measured animation frame, multiline edit, upload and suggestion-list resize.
    setHeight((reserved) => (following.offset.current <= END_DISTANCE ? next : Math.max(reserved, next)));
  }

  return {
    compact: compact && !protectedDraft,
    expand,
    height,
    measure,
    listProps: {
      ...following.listProps,
      onScroll: scroll,
      onScrollEndDrag: scroll,
      onMomentumScrollEnd: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        scroll(event);
        readerUntil.current = 0;
      },
      onScrollBeginDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        previous.current = event.nativeEvent.contentOffset.y;
        readerUntil.current = performance.now() + 250;
      },
      onMomentumScrollBegin: () => {
        readerUntil.current = performance.now() + 250;
      },
      // Skip the resizing header spacer when anchoring the first visible message.
      maintainVisibleContentPosition: { ...following.listProps.maintainVisibleContentPosition, minIndexForVisible: 1 },
    },
  };
}
