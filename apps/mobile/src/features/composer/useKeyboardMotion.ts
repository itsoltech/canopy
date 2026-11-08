import { useKeyboardHandler } from "react-native-keyboard-controller";
import { useSharedValue, type SharedValue } from "react-native-reanimated";

/** Keyboard corrections and interactive dismissal must never count as a gesture to fold the composer. */
export function useKeyboardMotion(reader: SharedValue<boolean>, travel: SharedValue<number>) {
  const moving = useSharedValue(false);

  useKeyboardHandler(
    {
      onStart: () => {
        "worklet";
        moving.set(true);
        reader.set(false);
      },
      onInteractive: () => {
        "worklet";
        moving.set(true);
        reader.set(false);
      },
      onEnd: () => {
        "worklet";
        moving.set(false);
        reader.set(false);
        travel.set(0);
      },
    },
    [moving, reader, travel],
  );

  return moving;
}
