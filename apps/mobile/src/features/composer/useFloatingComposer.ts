import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { useAnimatedScrollHandler, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { motion, smoothOut, useReducedMotion } from "../../ui/motion";
import type { useFollowingList } from "../../ui/useFollowingList";

// Match web's ComposerCompaction and FEED_END_THRESHOLD, in native layout points.
const END_DISTANCE = 8;
const COMPACT_DISTANCE = 192;
const COMPACT_TRAVEL = 96;

interface Fold {
  readonly progress: SharedValue<number>;
  /** Folding or opening right now: the composer is between its sizes. */
  readonly moving: SharedValue<boolean>;
  /** Reduced motion: switch at once. */
  readonly instant: SharedValue<boolean>;
}

/** Runs the fold on the UI thread (also when started from JS); an opening that ends hands the size to `settle`. */
function animate({ progress, moving, instant }: Fold, compact: boolean, settle: () => void) {
  "worklet";
  moving.set(true);
  const duration = instant.get() ? 0 : compact ? motion.medium : motion.slow;
  progress.set(
    withTiming(compact ? 0 : 1, { duration, easing: smoothOut }, (finished) => {
      if (!finished) return;
      moving.set(false);

      if (!compact) scheduleOnRN(settle);
    }),
  );
}

/**
 * The floating composer's fold (web: ComposerCompaction), decided and animated on the UI thread: the list's scroll
 * handler folds it after a reader gesture travels toward older messages and opens it at the end, in the same frame.
 * Stream updates, keyboard changes and anchor corrections are not reader gestures and change nothing.
 *
 * The timeline keeps a fixed reserve under its latest message: the expanded composer's height. Folding and opening
 * are overlay motion only, so no message moves; the reserve follows the composer only when it is open and settled
 * (a longer draft or an attachment). Popovers are outside the measured box and never change the reserve.
 */
export function useFloatingComposer<Item>(
  following: ReturnType<typeof useFollowingList<Item>>,
  protectedDraft = false,
) {
  const reduced = useReducedMotion();
  const [compact, setCompact] = useState(false);
  const [height, setHeight] = useState(0);
  // 1 open … 0 compact; every part of the composer follows it (ComposerMotionContext).
  const progress = useSharedValue(1);
  const moving = useSharedValue(false);
  const instant = useSharedValue(reduced);
  const folded = useSharedValue(false);
  const guarded = useSharedValue(protectedDraft);
  // A finger or its fling moves the list: only then does travel count.
  const reader = useSharedValue(false);
  const travel = useSharedValue(0);
  const previous = useSharedValue(0);
  const writing = useSharedValue(0);
  const room = useSharedValue(0);
  // The controls folding away for writing, or coming back.
  const shifting = useSharedValue(false);
  const [focused, setFocused] = useState(false);
  const focusedNow = useRef(false);
  const measured = useRef(0);
  const motionState = useMemo(() => ({ progress, moving, instant }), [progress, moving, instant]);
  const { track } = following;

  // The reserve follows the open composer once it has settled; a fold or its reversal never resizes it, and while
  // writing it only grows.
  const settle = useCallback(
    () => setHeight((reserve) => (focusedNow.current ? Math.max(reserve, measured.current) : measured.current)),
    [],
  );

  // The open motion from JS; React's flag follows separately (`expand`, or at render for a protected draft).
  const open = useCallback(() => {
    if (!folded.get()) return;
    folded.set(false);
    travel.set(0);
    animate(motionState, false, settle);
  }, [folded, travel, motionState, settle]);

  /** Opens it now (a tap, focus, typing): the motion starts on the UI thread in this frame. */
  function expand() {
    open();
    setCompact(false);
  }

  // A question or draft arriving while folded opens it until another reader gesture.
  if (protectedDraft && compact) setCompact(false);

  function fold(next: boolean) {
    "worklet";

    if (folded.get() === next) return;
    folded.set(next);
    travel.set(0);
    scheduleOnRN(setCompact, next);
    animate(motionState, next, settle);
  }

  useEffect(() => {
    instant.set(reduced);
  }, [instant, reduced]);

  // Writing: the controls fold away and the field grows into their room (`fast`, the same both ways).
  const onFocus = useCallback(
    (next: boolean) => {
      focusedNow.current = next;
      setFocused(next);
      shifting.set(true);
      writing.set(
        withTiming(next ? 1 : 0, { duration: reduced ? 0 : motion.fast, easing: smoothOut }, (finished) => {
          if (!finished) return;
          shifting.set(false);
          scheduleOnRN(settle);
        }),
      );
    },
    [writing, shifting, reduced, settle],
  );

  const composerMotion = useMemo(
    () => ({ progress, writing, room, focused, onFocus }),
    [progress, writing, room, focused, onFocus],
  );

  useEffect(() => {
    guarded.set(protectedDraft);

    if (protectedDraft) open();
  }, [protectedDraft, guarded, open]);

  const onScroll = useAnimatedScrollHandler({
    onBeginDrag: (event) => {
      reader.set(true);
      previous.set(event.contentOffset.y);
    },
    onEndDrag: (event) => {
      // A release without a fling ends the gesture; a fling keeps it until its momentum ends.
      if (Math.abs(event.velocity?.y ?? 0) < 0.05) reader.set(false);
    },
    onMomentumBegin: () => reader.set(true),
    onMomentumEnd: (event) => {
      reader.set(false);
      track(event.contentOffset.y);
    },
    onScroll: (event) => {
      const distance = Math.max(0, event.contentOffset.y);
      const up = distance - previous.get();
      previous.set(distance);
      track(distance);

      if (distance <= END_DISTANCE) return fold(false);

      if (!reader.get() || guarded.get()) return;
      travel.set(Math.max(0, travel.get() + up));

      if (distance >= COMPACT_DISTANCE && travel.get() >= COMPACT_TRAVEL) fold(true);
    },
  });

  function measure(event: LayoutChangeEvent) {
    measured.current = event.nativeEvent.layout.height;

    // Folded or moving, the composer is not at its open size: keep the reserve. While writing it only grows (a
    // longer draft); the controls folding away for the text must not pull the feed down.
    if (folded.get() || moving.get() || shifting.get()) return;

    if (focused ? measured.current > height : Math.abs(measured.current - height) >= 1) setHeight(measured.current);
  }

  return {
    compact,
    motion: composerMotion,
    expand,
    height,
    measure,
    listProps: {
      ...following.listProps,
      onScroll,
      // Skip the reserve spacer when anchoring the first visible message.
      maintainVisibleContentPosition: { ...following.listProps.maintainVisibleContentPosition, minIndexForVisible: 1 },
    },
  };
}
