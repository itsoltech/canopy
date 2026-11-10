import { useMemo, useState, type ReactNode } from "react";
import { useWindowDimensions } from "react-native";
import { useAnimatedReaction, useDerivedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useKeyboardFrame } from "../../ui/KeyboardWindow";
import { useContentInsets } from "../../ui/ScreenFrame";
import { ComposerMotionContext, useComposerMotion } from "./ComposerFold";

/** Short phones and landscape retain a one-row input and room for suggestions above it, even with the IME. */
export function ComposerViewport({ children }: { children: ReactNode }) {
  const base = useComposerMotion();
  const { height } = useWindowDimensions();
  const insets = useContentInsets();
  const keyboard = useKeyboardFrame();
  const { progress: expanded, writing: focused } = base;
  const [constrained, setConstrained] = useState(false);
  const short = useDerivedValue(() => height + keyboard.height.get() - insets.top < 320);
  const progress = useDerivedValue(() => (short.get() ? 0 : expanded.get()));
  const writing = useDerivedValue(() => (short.get() ? 0 : focused.get()));
  const value = useMemo(() => ({ ...base, progress, writing, constrained }), [base, progress, writing, constrained]);

  useAnimatedReaction(
    () => short.get(),
    (next, previous) => {
      if (next !== previous) scheduleOnRN(setConstrained, next);
    },
  );

  return <ComposerMotionContext.Provider value={value}>{children}</ComposerMotionContext.Provider>;
}
