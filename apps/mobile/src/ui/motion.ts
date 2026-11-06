import { useEffect, useSyncExternalStore, type ComponentProps } from "react";
import { AccessibilityInfo } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  Keyframe,
  LinearTransition,
  ReduceMotion,
  useReducedMotion as useStartupReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { motion } from "@canopy/ui";

/**
 * Motion on the web's token scale (@canopy/ui `motion` = routes/layout.css): open on `fast`, close on `quick`,
 * panels and sheets on `slow` / `medium`, `smoothOut` for surfaces, position and size, `inOut` for text and
 * skeleton reveal. Everything runs on the UI thread (Reanimated). With reduced motion nothing travels or scales:
 * surfaces and rows fade, text swaps, slides and layout changes are instant.
 */
export { motion };

export const smoothOut = Easing.bezierFn(...motion.smoothOut);
export const inOut = Easing.bezierFn(...motion.inOut);

// One subscription for every animated component; `undefined` until the system has answered.
let systemReduced: boolean | undefined;
const listeners = new Set<() => void>();
let subscription: { remove(): void } | undefined;

function setSystemReduced(value: boolean) {
  systemReduced = value;

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  if (!subscription) {
    subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setSystemReduced);
    void AccessibilityInfo.isReduceMotionEnabled().then(setSystemReduced);
  }

  return () => {
    listeners.delete(listener);

    if (listeners.size || !subscription) return;
    subscription.remove();
    subscription = undefined;
    systemReduced = undefined;
  };
}

/**
 * The system's reduce-motion setting, kept live. Until the system answers, the value Reanimated read
 * synchronously at startup stands in, so nothing slides on the first frame.
 */
export function useReducedMotion() {
  const startup = useStartupReducedMotion();

  return useSyncExternalStore(subscribe, () => systemReduced ?? startup);
}

type ViewProps = ComponentProps<typeof Animated.View>;

/** An enter / exit pair for `entering` / `exiting` of an Animated view; `undefined`: no motion. */
export interface Preset {
  readonly entering: ViewProps["entering"];
  readonly exiting: ViewProps["exiting"];
}

// Fades stay with reduced motion (opacity only), so they never follow the system's "skip" default.
const fadeIn = (ms: number, easing = smoothOut) => FadeIn.duration(ms).easing(easing).reduceMotion(ReduceMotion.Never);

const fadeOut = (ms: number, easing = smoothOut) =>
  FadeOut.duration(ms).easing(easing).reduceMotion(ReduceMotion.Never);

function from(style: { opacity: number; scale?: number; translateY?: number }, ms: number, easing = smoothOut) {
  const transform = (scale: number, translateY: number) => [{ translateY }, { scale }];

  return new Keyframe({
    0: { opacity: style.opacity, transform: transform(style.scale ?? 1, style.translateY ?? 0) },
    100: { opacity: 1, transform: transform(1, 0), easing },
  }).duration(ms);
}

function to(style: { opacity: number; scale?: number; translateY?: number }, ms: number, easing = smoothOut) {
  const transform = (scale: number, translateY: number) => [{ translateY }, { scale }];

  return new Keyframe({
    0: { opacity: 1, transform: transform(1, 0) },
    100: { opacity: style.opacity, transform: transform(style.scale ?? 1, style.translateY ?? 0), easing },
  }).duration(ms);
}

function toast(reduced: boolean, translateY: number): Preset {
  if (reduced) return { entering: fadeIn(motion.slow), exiting: fadeOut(motion.medium) };
  const hidden = { opacity: 0, scale: motion.scale.medium, translateY };

  return { entering: from(hidden, motion.slow), exiting: to(hidden, motion.medium) };
}

const rise: Preset = { entering: fadeIn(motion.fast), exiting: fadeOut(motion.quick) };

function presets(reduced: boolean) {
  return {
    /** A new row in a list or the timeline (web `rise` / `t-rise`): fade only, so measuring and anchoring hold. */
    rise,
    /** Something just added or newly counted (an attachment, a badge): grows in from `scale.medium` (web `pop`). */
    pop: reduced
      ? rise
      : {
          entering: from({ opacity: 0, scale: motion.scale.medium }, motion.fast),
          exiting: to({ opacity: 0, scale: motion.scale.medium }, motion.quick),
        },
    /** A notice or toast (web `t-toast`): rises from `distance.medium` and grows, in on `slow`, out on `medium`. */
    toast: toast(reduced, motion.distance.medium),
    /** The same for a banner at the top edge (in-app alerts): it comes down from above. */
    banner: toast(reduced, -motion.distance.medium),
    /** Text states swap, entering half (web `swap`): a changed label rises in from `distance.micro`. */
    swap: {
      entering: reduced ? undefined : from({ opacity: 0, translateY: motion.distance.micro }, motion.quick, inOut),
      exiting: undefined,
    } satisfies Preset,
    /**
     * Skeleton reveal (web `t-reveal`): loaded content resolves in where its skeleton was while the skeleton fades
     * out; instant when reduced.
     */
    reveal: {
      entering: reduced ? undefined : fadeIn(motion.slow, inOut),
      exiting: reduced ? undefined : fadeOut(motion.slow, inOut),
    } satisfies Preset,
    /** Neighbours glide to their new place when rows arrive, leave or reorder (web `reorder`). */
    layout: (reduced
      ? undefined
      : LinearTransition.duration(motion.fast).easing(smoothOut)) satisfies ViewProps["layout"],
  };
}

const full = presets(false);
const reducedPresets = presets(true);

/** The presets for the current reduce-motion setting. */
export function useMotion() {
  return useReducedMotion() ? reducedPresets : full;
}

/**
 * A value that eases to `target` on the UI thread (a pill's offset, a switch, a chevron's turn): `duration`
 * defaults to `fast` with `smoothOut`. With reduced motion, or `instant`, it jumps.
 */
export function useTween(
  target: number,
  {
    duration = motion.fast,
    easing = smoothOut,
    instant = false,
  }: { duration?: number; easing?: typeof smoothOut; instant?: boolean } = {},
): SharedValue<number> {
  const reduced = useReducedMotion();
  const value = useSharedValue(target);

  useEffect(() => {
    value.set(reduced || instant ? target : withTiming(target, { duration, easing }));
  }, [value, target, reduced, instant, duration, easing]);

  return value;
}
