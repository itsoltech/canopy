import { useLayoutEffect, useMemo } from "react";
import { PanResponder, type PanResponderGestureState } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { cancelAnimation, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import { useKeyboardFrame } from "./KeyboardWindow";
import { sheetSpring, useReducedMotion } from "./motion";
import { sheetDragDistance, sheetDragOffset, shouldDismissSheet } from "./sheet-gesture";
import { shouldMoveSheetResponder, shouldStartSheetResponder } from "./sheet-responder";

const dismissKeyboard = () => {
  void KeyboardController.dismiss();
};

/** Own the native responder lifecycle outside React rendering. */
function createSheetResponder(
  visible: boolean,
  start: () => void,
  move: (dy: number) => void,
  finish: (dy: number, vy: number, cancelled: boolean) => void,
) {
  let dragging = false;
  let claimedOnMove = false;

  const claimMove = (g: PanResponderGestureState) => {
    claimedOnMove = visible && shouldMoveSheetResponder(g, "header-control");

    return claimedOnMove;
  };

  return PanResponder.create({
    // Do not capture touch start: Pressables must receive taps before this bubbles to the chrome.
    onStartShouldSetPanResponder: (_, g) => visible && shouldStartSheetResponder(g, "drag-area"),
    onMoveShouldSetPanResponder: (_, g) => claimMove(g),
    onMoveShouldSetPanResponderCapture: (_, g) => claimMove(g),
    onPanResponderGrant: () => {
      // RN resets dy on grant. A capture has already crossed the threshold; a touch start has not.
      dragging = claimedOnMove;
      claimedOnMove = false;

      if (dragging) start();
    },
    onPanResponderReject: () => {
      claimedOnMove = false;
    },
    onPanResponderMove: (_, g) => {
      if (!dragging) {
        if (!shouldMoveSheetResponder(g, "drag-area")) return;
        dragging = true;
        start();
      }

      move(g.dy);
    },
    onPanResponderRelease: (_, g) => {
      if (dragging) finish(g.dy, g.vy * 1000, false);
      dragging = false;
    },
    onPanResponderTerminate: (_, g) => {
      if (dragging) finish(g.dy, 0, true);
      dragging = false;
    },
    onPanResponderTerminationRequest: () => false,
  }).panHandlers;
}

/** PanResponder delivers JS touch events; all position math, styles and settling run on the UI thread. */
export function useSheetGesture(
  progress: SharedValue<number>,
  velocity: SharedValue<number>,
  travel: SharedValue<number>,
  height: SharedValue<number>,
  visible: boolean,
  onClose: () => void,
  offset: SharedValue<number>,
  twoStops = false,
) {
  const reduced = useReducedMotion();
  const keyboard = useKeyboardFrame();
  const origin = useSharedValue(0);
  const keyboardOnly = useSharedValue(false);
  const enabled = useSharedValue(visible);

  useLayoutEffect(() => {
    enabled.set(visible);

    if (visible) offset.set(0);
  }, [enabled, visible, offset]);

  return useMemo(() => {
    const start = () => {
      "worklet";

      if (!enabled.get()) return;
      keyboardOnly.set(keyboard.height.get() < 0);

      if (keyboardOnly.get()) {
        scheduleOnRN(dismissKeyboard);

        return;
      }

      cancelAnimation(progress);
      cancelAnimation(offset);

      const distance = offset.get() + (1 - progress.get()) * travel.get();
      origin.set(sheetDragDistance(distance, height.get()));
      offset.set(distance);
      progress.set(1);
    };

    const move = (dy: number) => {
      "worklet";

      if (enabled.get() && !keyboardOnly.get()) offset.set(sheetDragOffset(origin.get() + dy, height.get()));
    };

    const finish = (dy: number, vy: number, cancelled: boolean) => {
      "worklet";

      if (!enabled.get() || keyboardOnly.get()) return;
      const distance = sheetDragOffset(origin.get() + dy, height.get());
      offset.set(distance);

      const dismiss = twoStops
        ? distance > height.get() * 0.65 && vy > -300
        : shouldDismissSheet(distance, height.get(), vy);

      if (!cancelled && dismiss) {
        // Exit takes over at the exact released position; the resting offset must not be applied twice.
        progress.set(1 - distance / travel.get());
        offset.set(0);
        velocity.set(-vy / travel.get());
        scheduleOnRN(onClose);
      } else {
        const target = twoStops && distance + (cancelled ? 0 : vy * 0.15) > height.get() * 0.2 ? height.get() * 0.4 : 0;
        offset.set(reduced ? target : withSpring(target, { ...sheetSpring, velocity: cancelled ? 0 : vy }));
      }
    };

    return createSheetResponder(
      visible,
      () => scheduleOnUI(start),
      (dy) => scheduleOnUI(move, dy),
      (dy, vy, cancelled) => scheduleOnUI(finish, dy, vy, cancelled),
    );
  }, [
    progress,
    velocity,
    travel,
    height,
    visible,
    onClose,
    reduced,
    keyboard.height,
    origin,
    keyboardOnly,
    enabled,
    offset,
    twoStops,
  ]);
}
