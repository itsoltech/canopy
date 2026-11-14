import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { cancelAnimation, ReduceMotion, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { sheetSpring, useReducedMotion } from "./motion";

/** Native dismissal callbacks arrive within a frame or two; a lost one must not block later overlays. */
const DISMISS_FALLBACK = 1000;

/**
 * The exit animation ends before the native modal dismisses; UIKit presentation must wait for both. `attached`
 * stays true until the native modal is gone. `hold` keeps the native modal while overlays presented from it remain:
 * UIKit would dismiss only the topmost one and leave this one on screen, invisible but catching every touch.
 */
export function useOverlayTransition(visible: boolean, onDismiss?: () => void, hold = false) {
  const progress = useSharedValue(0);
  const velocity = useSharedValue(0);
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  const [attached, setAttached] = useState(visible);
  const [measured, setMeasured] = useState(false);
  const didLayout = useCallback(() => setMeasured(true), []);
  const current = useRef({ visible, onDismiss });
  const dismissing = useRef(false);
  useLayoutEffect(() => {
    current.current = { visible, onDismiss };
  }, [visible, onDismiss]);

  if (visible && !mounted) setMounted(true);

  const native = mounted || (hold && attached);

  if (native && !attached) setAttached(true);

  if (!mounted && measured) setMeasured(false);

  const finishExit = useCallback(() => {
    // A completed worklet may reach JS after the overlay has reopened.
    if (current.current.visible) return;
    dismissing.current = true;
    setMounted(false);
  }, []);

  const didDismiss = useCallback(() => {
    if (current.current.visible) return;
    setAttached(false);

    if (!dismissing.current) return;
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
    if (Platform.OS !== "ios" && !native) didDismiss();
  }, [native, didDismiss]);

  useEffect(() => {
    if (native || !attached) return;
    const timer = setTimeout(() => setAttached(false), DISMISS_FALLBACK);

    return () => clearTimeout(timer);
  }, [native, attached]);

  return { progress, velocity, mounted, native, attached, didDismiss, didLayout };
}
