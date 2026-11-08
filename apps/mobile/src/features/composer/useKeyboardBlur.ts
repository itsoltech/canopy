import { useCallback, type RefObject } from "react";
import { useKeyboardHandler } from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

/** Android back hides the IME without blurring the field. End writing only after native dismissal settles. */
export function useKeyboardBlur(input: RefObject<{ blur(): void } | null>, focused: boolean) {
  const shown = useSharedValue(false);

  const blur = useCallback(() => {
    if (focused) input.current?.blur();
  }, [input, focused]);

  useKeyboardHandler(
    {
      onStart: (event) => {
        "worklet";

        if (event.height > 0) shown.set(true);
      },
      onEnd: (event) => {
        "worklet";

        if (event.height !== 0 || !shown.get()) return;
        shown.set(false);
        scheduleOnRN(blur);
      },
    },
    [shown, blur],
  );
}
