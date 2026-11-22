import { useCallback, useState } from "react";
import { Platform, type FlatList } from "react-native";
import {
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated";
import { useKeyboardFrame } from "./KeyboardWindow";
import { useContentInsets } from "./ScreenFrame";
import { useReaderMotion } from "./useReaderMotion";
import { scheduleOnRN } from "react-native-worklets";

/** Within this distance of the latest message the list counts as at the bottom and keeps following. */
const FOLLOW_THRESHOLD = 96;

/**
 * Chat feeds render inverted: offset 0 is the latest message, so a thread opens at its end without a jump,
 * new messages stay in view while the reader is at the bottom, and the position holds while they read history.
 * The scroll position lives on the UI thread; React hears only when the reader leaves or reaches the bottom.
 * Pass `listProps` to a Reanimated list (`Animated.FlatList`, `TimelineList`).
 */
export function useFollowingList<Item>(keyboardChat = false, initialComposerHeight = 0, initialDistance = 0) {
  const list = useAnimatedRef<FlatList<Item>>();
  const [atBottom, setAtBottom] = useState(initialDistance <= FOLLOW_THRESHOLD);
  const insets = useContentInsets();
  const ios = Platform.OS === "ios";

  const [initialOffset] = useState(
    () => initialDistance - (keyboardChat && ios ? insets.bottom + initialComposerHeight : 0),
  );

  const scrollY = useSharedValue(initialOffset);
  const corrections = useSharedValue(0);
  const bottom = useSharedValue(initialDistance <= FOLLOW_THRESHOLD);
  const correcting = useSharedValue(false);
  const anchoring = useSharedValue(initialDistance > FOLLOW_THRESHOLD);
  const reader = useReaderMotion(anchoring);
  const keyboard = useKeyboardFrame();
  const composerInset = useSharedValue(initialComposerHeight);

  // iOS exposes the chat inset as a negative offset; Android's synthetic inset keeps its end at zero.
  const minimum = useDerivedValue(() =>
    keyboardChat && ios
      ? Math.min(0, keyboard.height.get() + insets.bottom * keyboard.progress.get()) -
        insets.bottom -
        composerInset.get()
      : 0,
  );

  const distance = useCallback(
    (y: number) => {
      "worklet";

      return Math.max(0, y - minimum.get());
    },
    [minimum],
  );

  const isFollowing = useCallback(
    (offset = scrollY.get()) => distance(offset) <= FOLLOW_THRESHOLD,
    [scrollY, distance],
  );

  /** Records a scroll position (a worklet: scroll handlers call it on the UI thread). `own`: a position this
   * feed just set itself (an anchor correction), which the reader then reads from. */
  const track = useCallback(
    (y: number, own = false) => {
      "worklet";
      const away = distance(y);

      if (away <= 0.5) reader.arrived();
      scrollY.set(y);

      // UIKit may clamp a correction and synchronously emit another scroll event while keyboard insets change.
      // Record its actual position without issuing a nested command or dropping the intent to follow latest.
      if (correcting.get()) return;

      // Native anchoring keeps the first visible row in place when rows arrive under it (a sent message, the answer it
      // starts): a reader following the end stays there instead, as on the web.
      if (!own && away > 0.5 && bottom.get() && !anchoring.get() && reader.idle()) {
        correcting.set(true);
        corrections.set(corrections.get() + 1);

        try {
          scrollTo(list, 0, minimum.get(), false);
        } finally {
          correcting.set(false);
        }

        return;
      }

      if (anchoring.get()) return;
      const at = away <= FOLLOW_THRESHOLD;

      if (at === bottom.get()) return;
      bottom.set(at);
      scheduleOnRN(setAtBottom, at);
    },
    [scrollY, bottom, correcting, corrections, distance, anchoring, reader, list, minimum],
  );

  function jump(animated: boolean) {
    reader.seek(animated);
    anchoring.set(false);
    corrections.set(corrections.get() + 1);
    const end = minimum.get();
    list.current?.scrollToOffset({ offset: end, animated });
    scrollY.set(end);
    bottom.set(true);
    setAtBottom(true);
  }

  const onScroll = useAnimatedScrollHandler({
    onBeginDrag: reader.begin,
    onEndDrag: reader.end,
    onMomentumBegin: reader.momentum,
    onScroll: (event) => track(event.contentOffset.y),
    onMomentumEnd: (event) => {
      track(event.contentOffset.y);
      reader.end();
    },
  });

  function correctReading(offset: number) {
    corrections.set(corrections.get() + 1);
    list.current?.scrollToOffset({ offset: Math.max(minimum.get(), offset), animated: false });
  }

  function finishReading(offset = scrollY.get(), reapply = false) {
    const at = isFollowing(offset);

    if (reapply || Math.abs(scrollY.get() - offset) >= 1) correctReading(offset);
    scrollY.set(offset);
    anchoring.set(false);
    bottom.set(at);
    setAtBottom(at);
  }

  return {
    list,
    initialOffset,
    composerInset,
    scrollY,
    anchoring,
    isFollowing,
    atBottom,
    track,
    reader,
    distance,
    minimum,
    corrections,
    correctReading,
    finishReading,
    resumeFollowing: () => jump(false),
    showLatest: () => jump(true),
    listProps: {
      ref: list,
      inverted: true,
      onScroll,
      scrollEventThrottle: 16,
      // Native autoscroll targets zero, ignoring the chat's negative inset on iOS.
      maintainVisibleContentPosition: keyboardChat
        ? { minIndexForVisible: 0 }
        : { minIndexForVisible: 0, autoscrollToTopThreshold: FOLLOW_THRESHOLD },
    },
  };
}
