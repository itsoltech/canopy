import { forwardRef, useImperativeHandle, useRef, type ComponentRef } from "react";
import { ScrollView, type ScrollViewProps } from "react-native";
import Animated, {
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedRef,
  useScrollOffset,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useKeyboardHandler, type NativeEvent } from "react-native-keyboard-controller";
import { useContentInsets } from "../../ui/ScreenFrame";
import { useKeyboardFrame } from "../../ui/KeyboardWindow";

/** Inverted iOS chat: commit inset and offset together on each native frame, retaining distance from the end. */
export const IOSChatScrollView = forwardRef<
  ComponentRef<typeof ScrollView>,
  ScrollViewProps & { composerInset?: SharedValue<number> }
>(function IOSChatScrollView({ composerInset, ...props }, ref) {
  const safe = useContentInsets().bottom;
  const keyboard = useKeyboardFrame();
  const scroll = useAnimatedRef<ComponentRef<typeof ScrollView>>();
  const initial = useRef(props.contentOffset ?? { x: 0, y: -safe - (composerInset?.get() ?? 0) });
  const y = useSharedValue(initial.current.y);
  useScrollOffset(scroll, y);
  const inset = useSharedValue(safe + (composerInset?.get() ?? 0));
  const relative = useSharedValue(0);
  const target = useSharedValue(initial.current.y);
  const emitted = useSharedValue<number | null>(null);
  const interactive = useSharedValue(false);

  useImperativeHandle(ref, () => {
    const view = scroll.current;

    if (!view) throw new Error("Chat scroll view must be mounted before its handle is read.");

    return view;
  }, [scroll]);

  // Safe areas may change without any keyboard event, including a rotation with the keyboard closed.
  useAnimatedReaction(
    () => safe + (composerInset?.get() ?? 0),
    () => {
      const next =
        Math.max(0, -keyboard.height.get() + safe * (1 - keyboard.progress.get())) + (composerInset?.get() ?? 0);

      relative.set(y.get() + inset.get());
      const follows = relative.get() <= 96;
      inset.set(next);
      target.set(follows ? -next : Math.max(-next, y.get()));
    },
  );

  const move = (event: NativeEvent) => {
    "worklet";
    const next = Math.max(0, event.height + safe * (1 - event.progress)) + (composerInset?.get() ?? 0);
    inset.set(next);

    // UIKit owns contentOffset during an interactive drag and its final release animation.
    if (!interactive.get()) target.set(relative.get() <= 96 ? relative.get() - next : Math.max(-next, y.get()));
  };

  useKeyboardHandler(
    {
      onStart: () => {
        "worklet";

        if (!interactive.get()) relative.set(y.get() + inset.get());
      },
      onMove: move,
      onInteractive: (event) => {
        "worklet";
        interactive.set(true);
        move(event);
      },
      onEnd: (event) => {
        "worklet";
        move(event);
        interactive.set(false);
      },
    },
    [safe, y, inset, relative, target, interactive],
  );

  const animatedProps = useAnimatedProps(() => {
    const next = target.get();
    const changed = emitted.get() !== next;
    emitted.set(next);

    let updates: ScrollViewProps = {
      contentInset: { top: inset.get(), bottom: 0, left: 0, right: 0 },
      scrollIndicatorInsets: { top: inset.get(), bottom: 0, left: 0, right: 0 },
    };

    // Inset-only commits must not replay an old scroll command after the user has scrolled.
    if (changed) updates = { ...updates, contentOffset: { x: 0, y: next } };

    if (changed) y.set(next);

    return updates;
  });

  return <Animated.ScrollView {...props} ref={scroll} contentOffset={initial.current} animatedProps={animatedProps} />;
});
