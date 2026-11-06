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
export function ComposerFold({ open, children }: { open: boolean; children: ReactNode }) {
  const { progress, writing, room } = useComposerMotion();
  const height = useSharedValue(0);
  // This row's share of the room, in JS: changes go to the UI thread as deltas, so two rows never race.
  const share = useRef(0);

  useEffect(() => {
    const own = share;
    scheduleOnUI(grow, room, own.current);

    return () => scheduleOnUI(grow, room, -own.current);
  }, [room]);

  const style = useAnimatedStyle(() => {
    const shown = controlsShown({ progress, writing });

    return { height: height.get() * shown, opacity: shown };
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
          scheduleOnUI(grow, room, next - share.current);
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
