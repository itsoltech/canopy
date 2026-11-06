import { useEffect, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Icon } from "./Icon";
import { motion, smoothOut, useMotion, useReducedMotion, useTween, type Preset } from "./motion";

/**
 * Accordion expand / collapse (web `expand`): the content's height grows from and shrinks to 0 with a quiet fade,
 * on `fast` both ways. It stays mounted until it has closed; open and settled it takes its own height, so content
 * that grows later is never clipped. With reduced motion it only fades.
 */
export function Expand({
  open,
  children,
  style,
}: {
  open: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(open ? 1 : 0);
  const height = useSharedValue(0);

  if (open && !mounted) setMounted(true);
  useEffect(() => {
    progress.set(
      withTiming(
        open ? 1 : 0,
        { duration: motion.fast, easing: smoothOut, reduceMotion: ReduceMotion.Never },
        (finished) => {
          if (finished && !open) scheduleOnRN(setMounted, false);
        },
      ),
    );
  }, [open, progress]);

  const animated = useAnimatedStyle(() => {
    const t = progress.get();

    return { opacity: t, height: reduced || t >= 1 ? "auto" : height.get() * t };
  });

  if (!mounted) return null;

  return (
    <Animated.View style={[{ overflow: "hidden" }, animated]}>
      <View onLayout={(event) => height.set(event.nativeEvent.layout.height)} style={style}>
        {children}
      </View>
    </Animated.View>
  );
}

/**
 * Text states swap (web `swap`): when `value` changes, the new content rises in from `distance.micro`. The first
 * render shows it at once; with reduced motion every change does.
 */
export function Swap({ value, children, style }: { value: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { swap } = useMotion();

  return (
    <LayoutAnimationConfig skipEntering>
      <Animated.View key={value} entering={swap.entering} style={style}>
        {children}
      </Animated.View>
    </LayoutAnimationConfig>
  );
}

/** A disclosure chevron that turns with its panel (web `t-acc-chevron`): right when closed, down when open. */
export function Chevron({ open, size, color }: { open: boolean; size?: number; color?: string }) {
  const turn = useTween(open ? 90 : 0);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get()}deg` }] }));

  return (
    <Animated.View style={style}>
      <Icon name="chevron-right" size={size} color={color} />
    </Animated.View>
  );
}

/** The rows a list has committed: a render compares against the ones before it. */
class ShownRows {
  private readonly keys = new Set<string>();
  primed = false;

  commit(keys: readonly string[]) {
    for (const key of keys) this.keys.add(key);
    this.primed = true;
  }

  has(key: string) {
    return this.keys.has(key);
  }
}

/**
 * How rows of a virtualized list enter: the first rows after a skeleton resolve in (`reveal`), rows added later rise
 * in (`rise`), and rows already shown once (scrolled back into view, remounted) appear at once. Lists that are ready
 * on their first render show their rows at once.
 */
export function useArrivals(keys: readonly string[], ready = true): (key: string) => Preset["entering"] {
  const { rise, reveal } = useMotion();
  const [waited, setWaited] = useState(!ready);
  const [shown] = useState(() => new ShownRows());

  if (!ready && !waited) setWaited(true);
  useEffect(() => {
    if (ready) shown.commit(keys);
  }, [keys, ready, shown]);

  return (key) => (!shown.primed ? (waited ? reveal.entering : undefined) : shown.has(key) ? undefined : rise.entering);
}

/**
 * A list cell that glides to its new place when rows above it arrive, leave or move (web `reorder`); pass it as
 * `CellRendererComponent` of a SectionList or FlatList.
 */
export function GlidingCell({
  children,
  onLayout,
  style,
}: {
  children: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  style: StyleProp<ViewStyle>;
}) {
  const { layout } = useMotion();

  return (
    <Animated.View layout={layout} onLayout={onLayout} style={style}>
      {children}
    </Animated.View>
  );
}

/**
 * Press feedback for a floating control: it settles to `scale.medium` while held (in on `quick`, back on `fast`).
 * None with reduced motion: the pressed colour carries it.
 */
export function usePressScale() {
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));

  const press = (to: number, duration: number) => () => {
    if (!reduced) scale.set(withTiming(to, { duration, easing: smoothOut }));
  };

  return { style, onPressIn: press(motion.scale.medium, motion.quick), onPressOut: press(1, motion.fast) };
}
