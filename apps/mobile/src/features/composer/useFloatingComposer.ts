import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useComposerScroll } from "./useComposerScroll";
import { motion, smoothOut, useReducedMotion } from "../../ui/motion";
import type { useFollowingList } from "../../ui/useFollowingList";

interface Fold {
  readonly progress: SharedValue<number>;
  /** Folding or opening right now: the composer is between its sizes. */
  readonly moving: SharedValue<boolean>;
  /** Reduced motion: switch at once. */
  readonly instant: SharedValue<boolean>;
}

/** Folding only animates the overlay; neither direction changes the timeline's reserve on completion. */
function animate({ progress, moving, instant }: Fold, compact: boolean) {
  "worklet";
  moving.set(true);
  const duration = instant.get() ? 0 : compact ? motion.medium : motion.slow;
  progress.set(
    withTiming(compact ? 0 : 1, { duration, easing: smoothOut }, (finished) => {
      if (!finished) return;
      moving.set(false);
    }),
  );
}

/**
 * The floating composer's fold (web: ComposerCompaction), decided and animated on the UI thread: the list's scroll
 * handler folds it after a reader gesture travels toward older messages and opens it at the end, in the same frame.
 * Stream updates, keyboard changes and anchor corrections are not reader gestures and change nothing.
 *
 * Thread feeds measure the entire overlay on the UI thread and expose it as a native scroll inset. Other chats
 * retain the measured expanded input height through folding; their accessories join the reserve at the end.
 * This input measurement serves keyboard gestures. Popovers, keyboard and safe areas are separate.
 */
export function useFloatingComposer<Item>(
  following: ReturnType<typeof useFollowingList<Item>>,
  protectedDraft = false,
  initialHeight = 0,
) {
  const reduced = useReducedMotion();
  const [compact, setCompact] = useState(false);
  const [height, setHeight] = useState(initialHeight);
  // 1 open … 0 compact; every part of the composer follows it (ComposerMotionContext).
  const progress = useSharedValue(1);
  const moving = useSharedValue(false);
  const instant = useSharedValue(reduced);
  const folded = useSharedValue(false);
  const opening = useSharedValue(false);
  const guarded = useSharedValue(protectedDraft);
  const writing = useSharedValue(0);
  const room = useSharedValue(0);
  // The controls folding away for writing, or coming back.
  const shifting = useSharedValue(false);
  const [focused, setFocused] = useState(false);
  const focusedNow = useRef(false);
  const measured = useRef(0);
  const accessoryMeasured = useRef(0);
  const [accessory, setAccessory] = useState(0);
  const motionState = useMemo(() => ({ progress, moving, instant }), [progress, moving, instant]);

  const settle = useCallback(() => {
    if (folded.get() || opening.get() || moving.get() || shifting.get()) return;
    setHeight((reserve) => (focusedNow.current ? Math.max(reserve, measured.current) : measured.current));
  }, [folded, opening, moving, shifting]);

  const fold = useCallback(
    (next: boolean) => {
      "worklet";

      if (folded.get() === next) return false;
      folded.set(next);
      opening.set(!next);
      scheduleOnRN(setCompact, next);
      animate(motionState, next);

      return true;
    },
    [folded, opening, motionState],
  );

  const { onScroll, reset } = useComposerScroll(following, moving, guarded, fold);

  // The open motion from JS; React's flag follows separately (`expand`, or at render for a protected draft).
  const open = useCallback(() => {
    reset();

    // An interaction with an already open input can change its natural size, including making it shorter.
    if (!folded.get() && !moving.get()) opening.set(false);
    fold(false);
  }, [reset, fold, folded, moving, opening]);

  /** Opens it now (a tap, focus, typing): the motion starts on the UI thread in this frame. */
  function expand() {
    open();
    setCompact(false);
  }

  // A question or draft arriving while folded opens it until another reader gesture.
  if (protectedDraft && compact) setCompact(false);

  useEffect(() => {
    instant.set(reduced);
  }, [instant, reduced]);

  // Writing: the controls fold away and the field grows into their room (`fast`, the same both ways).
  const onFocus = useCallback(
    (next: boolean) => {
      focusedNow.current = next;
      reset();
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
    [writing, shifting, reduced, settle, reset],
  );

  const composerMotion = useMemo(
    () => ({ progress, writing, room, focused, onFocus }),
    [progress, writing, room, focused, onFocus],
  );

  useEffect(() => {
    guarded.set(protectedDraft);

    if (protectedDraft) open();
  }, [protectedDraft, guarded, open]);

  // Back at the end, the reserve takes what floated over history while reading.
  const { atBottom, isFollowing } = following;
  useEffect(() => {
    if (atBottom) setAccessory(accessoryMeasured.current);
  }, [atBottom]);

  function measureAccessory(next: number) {
    accessoryMeasured.current = next;

    if (isFollowing()) setAccessory(next);
  }

  function measure(event: LayoutChangeEvent) {
    measured.current = event.nativeEvent.layout.height;

    // Only real expanded-content changes (drafts/files) update the reserve. Folding never releases it.
    if (folded.get() || moving.get() || shifting.get()) return;

    // onLayout crosses to JS: a partial frame can arrive after the UI animation's completion callback.
    // Keep the existing reserve until an expanded measurement catches up, even with reduced motion.
    if (opening.get()) {
      if (measured.current < height) return;
      opening.set(false);
    }

    if (focused ? measured.current > height : Math.abs(measured.current - height) >= 1) {
      reset();
      settle();
    }
  }

  return {
    compact,
    motion: composerMotion,
    expand,
    showLatest: () => {
      expand();
      following.showLatest();
    },
    height,
    reserve: height + accessory,
    measure,
    measureAccessory,
    listProps: {
      // FlatList already accounts for ListHeaderComponent; index 0 is the newest turn, not the reserve.
      ...following.listProps,
      onScroll,
    },
  };
}
