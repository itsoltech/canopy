import { useLayoutEffect, useMemo } from "react";
import { PanResponder } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { cancelAnimation, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import { useKeyboardFrame } from "./KeyboardWindow";
import { sheetSpring, useReducedMotion } from "./motion";
import { sheetDragDistance, sheetDragOffset, shouldDismissSheet } from "./sheet-gesture";

const dismissKeyboard = () => {
  void KeyboardController.dismiss();
};

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

    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        g.numberActiveTouches === 1 && Math.abs(g.dy) > 5 && Math.abs(g.dy) > Math.abs(g.dx),
      onMoveShouldSetPanResponderCapture: (_, g) =>
        g.numberActiveTouches === 1 && Math.abs(g.dy) > 5 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderGrant: () => scheduleOnUI(start),
      onPanResponderMove: (_, g) => scheduleOnUI(move, g.dy),
      onPanResponderRelease: (_, g) => scheduleOnUI(finish, g.dy, g.vy * 1000, false),
      onPanResponderTerminate: (_, g) => scheduleOnUI(finish, g.dy, 0, true),
      onPanResponderTerminationRequest: () => false,
    }).panHandlers;
  }, [progress, velocity, travel, height, onClose, reduced, keyboard.height, origin, keyboardOnly, enabled]);
}
