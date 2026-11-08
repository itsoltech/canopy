import { createContext, useContext, useMemo, type ReactNode } from "react";
import { KeyboardProvider, useKeyboardHandler, type NativeEvent } from "react-native-keyboard-controller";
import { useSharedValue, type SharedValue } from "react-native-reanimated";

interface KeyboardFrame {
  readonly height: SharedValue<number>;
  readonly progress: SharedValue<number>;
}

const Frame = createContext<KeyboardFrame | null>(null);

/** Native frame values, including interactive gestures; iOS start events contain destinations, not positions. */
function KeyboardFrames({ children }: { children: ReactNode }) {
  const height = useSharedValue(0);
  const progress = useSharedValue(0);
  const frame = useMemo(() => ({ height, progress }), [height, progress]);

  const track = (event: NativeEvent) => {
    "worklet";
    height.set(-event.height);
    progress.set(event.progress);
  };

  useKeyboardHandler({ onMove: track, onInteractive: track, onEnd: track }, [height, progress]);

  return <Frame.Provider value={frame}>{children}</Frame.Provider>;
}

/** Each native window owns its provider and frame stream, including searchable modal windows. */
export function KeyboardWindow({ children, preload = true }: { children: ReactNode; preload?: boolean }) {
  return (
    <KeyboardProvider statusBarTranslucent navigationBarTranslucent preload={preload}>
      <KeyboardFrames>{children}</KeyboardFrames>
    </KeyboardProvider>
  );
}

export function useKeyboardFrame() {
  const frame = useContext(Frame);

  if (!frame) throw new Error("Keyboard motion requires a KeyboardWindow.");

  return frame;
}
