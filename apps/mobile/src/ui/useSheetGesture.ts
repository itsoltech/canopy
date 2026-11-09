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
) {
  const reduced = useReducedMotion();
  const keyboard = useKeyboardFrame();
  const origin = useSharedValue(0);
  const keyboardOnly = useSharedValue(false);
  const enabled = useSharedValue(visible);

  useLayoutEffect(() => {
    enabled.set(visible);
  }, [enabled, visible]);

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
      origin.set(sheetDragDistance((1 - progress.get()) * travel.get(), height.get()));
    };

    const move = (dy: number) => {
      "worklet";

      if (enabled.get() && !keyboardOnly.get())
        progress.set(1 - sheetDragOffset(origin.get() + dy, height.get()) / travel.get());
    };

    const finish = (dy: number, vy: number, cancelled: boolean) => {
      "worklet";

      if (!enabled.get() || keyboardOnly.get()) return;
      const offset = sheetDragOffset(origin.get() + dy, height.get());
      progress.set(1 - offset / travel.get());

      if (!cancelled && shouldDismissSheet(offset, height.get(), vy)) {
        velocity.set(-vy / travel.get());
        scheduleOnRN(onClose);
      } else {
        progress.set(reduced ? 1 : withSpring(1, { ...sheetSpring, velocity: -vy / travel.get() }));
      }
    };

    return createSheetResponder(
      visible,
      () => scheduleOnUI(start),
      (dy) => scheduleOnUI(move, dy),
      (dy, vy, cancelled) => scheduleOnUI(finish, dy, vy, cancelled),
    );
  }, [progress, velocity, travel, height, visible, onClose, reduced, keyboard.height, origin, keyboardOnly, enabled]);
}
