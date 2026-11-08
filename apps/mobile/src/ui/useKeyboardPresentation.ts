import { useEffect, useState } from "react";
import { KeyboardController } from "react-native-keyboard-controller";

/** A native modal must not steal the input's window halfway through keyboard dismissal. */
export function useKeyboardPresentation(visible: boolean) {
  const [ready, setReady] = useState(false);

  if (!visible && ready) setReady(false);

  useEffect(() => {
    let current = true;

    if (visible) {
      void KeyboardController.dismiss().then(() => {
        if (current) setReady(true);
      });
    }

    return () => {
      current = false;
    };
  }, [visible]);

  return visible && ready;
}
