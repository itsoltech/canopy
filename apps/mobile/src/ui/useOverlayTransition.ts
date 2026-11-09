import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { cancelAnimation, ReduceMotion, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { sheetSpring, useReducedMotion } from "./motion";

/** The exit animation ends before the native modal dismisses; UIKit presentation must wait for both. */
export function useOverlayTransition(visible: boolean, onDismiss?: () => void) {
  const progress = useSharedValue(0);
  const velocity = useSharedValue(0);
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  const [measured, setMeasured] = useState(false);
  const didLayout = useCallback(() => setMeasured(true), []);
  const current = useRef({ visible, onDismiss });
  const dismissing = useRef(false);
  useLayoutEffect(() => {
    current.current = { visible, onDismiss };
  }, [visible, onDismiss]);

  if (visible && !mounted) setMounted(true);

  if (!mounted && measured) setMeasured(false);

  const finishExit = useCallback(() => {
    // A completed worklet may reach JS after the overlay has reopened.
    if (current.current.visible) return;
    dismissing.current = true;
    setMounted(false);
  }, []);

  const didDismiss = useCallback(() => {
    if (!dismissing.current || current.current.visible) return;
    dismissing.current = false;
    current.current.onDismiss?.();
  }, []);

  useEffect(() => {
    if (!mounted || (visible && !measured)) return;

    const finish = (finished?: boolean) => {
      "worklet";

      if (finished && !visible) scheduleOnRN(finishExit);
    };

    const target = visible ? 1 : 0;
    progress.set(
      reduced
        ? withTiming(target, { duration: 0, reduceMotion: ReduceMotion.Never }, finish)
        : withSpring(target, { ...sheetSpring, velocity: visible ? 0 : velocity.get() }, finish),
    );
    velocity.set(0);

    return () => cancelAnimation(progress);
  }, [visible, mounted, measured, reduced, progress, velocity, finishExit]);

  useEffect(() => {
    // RN only emits Modal.onDismiss on iOS. Android removes its unanimated Dialog in the native
    // commit when visible becomes false; invoke the action after that commit, never during exit.
    if (Platform.OS !== "ios" && !mounted) didDismiss();
  }, [mounted, didDismiss]);

  return { progress, velocity, mounted, didDismiss, didLayout };
}
