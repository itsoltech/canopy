import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { View } from "react-native";
import Animated, { makeMutable, useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";

/** The floating composer's motion on the UI thread (useFloatingComposer); every part of the composer reads it. */
export interface ComposerMotion {
  /** How open it is: 0 compact … 1 expanded. */
  readonly progress: SharedValue<number>;
  /** 0 … 1 while the field has focus: the controls make room for the text. */
  readonly writing: SharedValue<number>;
  /** The folding rows' measured height: the room the field takes over while writing. */
  readonly room: SharedValue<number>;
  /** The field has focus (React's copy, for touch and accessibility). */
  readonly focused: boolean;
  readonly onFocus: (focused: boolean) => void;
}

/** A composer outside a floating layout (new thread, side-thread creation): always open, controls always shown. */
const fixed: ComposerMotion = {
  progress: makeMutable(1),
  writing: makeMutable(0),
  room: makeMutable(0),
  focused: false,
  onFocus: () => {},
};

export const ComposerMotionContext = createContext<ComposerMotion>(fixed);

export function useComposerMotion() {
  return useContext(ComposerMotionContext);
}

/** How far the controls show: folding hides them, and so does writing. */
export function controlsShown({ progress, writing }: Pick<ComposerMotion, "progress" | "writing">) {
  "worklet";

  return Math.min(progress.get(), 1 - writing.get());
}

function grow(room: SharedValue<number>, delta: number) {
  "worklet";
  room.set(room.get() + delta);
}

/**
 * Native counterpart of ComposerFold: the controls stay mounted (pickers and their choices keep their state); their
 * own clipped height and opacity follow the composer's motion on the UI thread. Only this overlay lays out while it
 * moves, never the timeline beside it.
 */
export function ComposerFold({
  open,
  hideWhileWriting = true,
  children,
}: {
  open: boolean;
  /** The main toolbar stays visible while typing and gives none of its height to the field. */
  hideWhileWriting?: boolean;
  children: ReactNode;
}) {
  const { progress, writing, room } = useComposerMotion();
  const height = useSharedValue(0);
  // This row's share of the room, in JS: changes go to the UI thread as deltas, so two rows never race.
  const share = useRef(0);

  useEffect(() => {
    if (!hideWhileWriting) return;
    const own = share;
    scheduleOnUI(grow, room, own.current);

    return () => scheduleOnUI(grow, room, -own.current);
  }, [room, hideWhileWriting]);

  const style = useAnimatedStyle(() => {
    const shown = hideWhileWriting ? controlsShown({ progress, writing }) : progress.get();
    const expanded = Math.min(1, progress.get() / 0.8);
    const size = hideWhileWriting ? Math.min(expanded, 1 - writing.get()) : expanded;

    // Give the row all of its room before painting controls. In reverse they disappear before the clip closes:
    // a partly open clip must never draw half a button or let it cross the moving send button.
    // Writing still hands exactly its share of the row to the field on each frame.
    return { height: height.get() * size, opacity: Math.max(0, (shown - 0.8) / 0.2) };
  });

  return (
    <Animated.View
      pointerEvents={open ? "auto" : "none"}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      style={[{ overflow: "hidden" }, style]}
    >
      <View
        onLayout={(event) => {
          const next = event.nativeEvent.layout.height;

          if (hideWhileWriting) scheduleOnUI(grow, room, next - share.current);
          share.current = next;
          height.set(next);
        }}
        style={{ position: "absolute", top: 0, left: 0, right: 0 }}
      >
        {children}
      </View>
    </Animated.View>
  );
}
