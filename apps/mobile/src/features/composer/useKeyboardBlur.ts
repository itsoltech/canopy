import { useCallback, useEffect, type RefObject } from "react";
import { Keyboard } from "react-native";
import { useKeyboardHandler } from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

/** End writing after dismissal settles, even if the keyboard frame stream missed a transition. */
export function useKeyboardBlur(input: RefObject<{ blur(): void } | null>) {
  const shown = useSharedValue(false);

  const blur = useCallback(() => {
    input.current?.blur();
  }, [input]);

  useEffect(() => {
    const listener = Keyboard.addListener("keyboardDidHide", blur);

    return () => listener.remove();
  }, [blur]);

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
