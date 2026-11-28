import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Platform } from "react-native";
import { KeyboardProvider, useKeyboardHandler, type NativeEvent } from "react-native-keyboard-controller";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useAndroidKeyboardFallback } from "./useAndroidKeyboardFallback";

interface KeyboardFrame {
  readonly height: SharedValue<number>;
  readonly progress: SharedValue<number>;
}

const Frame = createContext<KeyboardFrame | null>(null);

/** Native frame values, including interactive gestures; iOS start events contain destinations, not positions. */
function KeyboardFrames({ children }: { children: ReactNode }) {
  const height = useSharedValue(0);
  const progress = useSharedValue(0);
  const moving = useSharedValue(false);
  const frame = useMemo(() => ({ height, progress }), [height, progress]);

  const track = (event: NativeEvent) => {
    "worklet";
    height.set(-event.height);
    progress.set(event.progress);
  };

  useKeyboardHandler(
    {
      onStart: () => {
        "worklet";
        moving.set(true);
      },
      onMove: track,
      onInteractive: track,
      onEnd: (event) => {
        "worklet";
        track(event);
        moving.set(false);
      },
    },
    [height, progress, moving],
  );
  useAndroidKeyboardFallback(height, progress, moving);

  return <Frame.Provider value={frame}>{children}</Frame.Provider>;
}

/** Each native window owns its provider and frame stream, including searchable modal windows. */
export function KeyboardWindow({ children, preload = true }: { children: ReactNode; preload?: boolean }) {
  const window = (
    <KeyboardProvider statusBarTranslucent navigationBarTranslucent preload={preload}>
      <KeyboardFrames>{children}</KeyboardFrames>
    </KeyboardProvider>
  );

  return Platform.OS === "android" ? (
    <GestureHandlerRootView style={{ flex: 1 }}>{window}</GestureHandlerRootView>
  ) : (
    window
  );
}

export function useKeyboardFrame() {
  const frame = useContext(Frame);

  if (!frame) throw new Error("Keyboard motion requires a KeyboardWindow.");

  return frame;
}

/** Distance the keyboard lifts content that already reserves the bottom safe area. */
export function keyboardLift(frame: KeyboardFrame, bottom: number) {
  "worklet";

  return Math.max(0, -frame.height.get() - bottom * frame.progress.get());
}
