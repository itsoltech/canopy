import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { cancelAnimation, ReduceMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { motion, smoothOut } from "./motion";

/** The exit animation ends before the native modal dismisses; UIKit presentation must wait for both. */
export function useOverlayTransition(visible: boolean, wide: boolean, onDismiss?: () => void) {
  const progress = useSharedValue(0);
  const [mounted, setMounted] = useState(visible);
  const current = useRef({ visible, onDismiss });
  const dismissing = useRef(false);
  useLayoutEffect(() => {
    current.current = { visible, onDismiss };
  }, [visible, onDismiss]);

  if (visible && !mounted) setMounted(true);

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
    if (!mounted) return;
    const duration = wide ? (visible ? motion.fast : motion.quick) : visible ? motion.slow : motion.medium;
    progress.set(
      withTiming(visible ? 1 : 0, { duration, easing: smoothOut, reduceMotion: ReduceMotion.Never }, (finished) => {
        if (finished && !visible) scheduleOnRN(finishExit);
      }),
    );

    return () => cancelAnimation(progress);
  }, [visible, mounted, wide, progress, finishExit]);

  useEffect(() => {
    // RN only emits Modal.onDismiss on iOS. Android removes its unanimated Dialog in the native
    // commit when visible becomes false; invoke the action after that commit, never during exit.
    if (Platform.OS !== "ios" && !mounted) didDismiss();
  }, [mounted, didDismiss]);

  return { progress, mounted, didDismiss };
}
