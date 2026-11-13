import {
  LinearTransition,
  withTiming,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
} from "react-native-reanimated";
import { motion, smoothOut, useReducedMotion, type Preset } from "./motion";

/** Height, fade and a small rise for panels anchored above the composer. */
function entering(values: EntryAnimationsValues) {
  "worklet";
  const config = { duration: motion.slow, easing: smoothOut };

  return {
    initialValues: { height: 0, opacity: 0, transform: [{ translateY: motion.distance.micro }] },
    animations: {
      height: withTiming(values.targetHeight, config),
      opacity: withTiming(1, config),
      transform: [{ translateY: withTiming(0, config) }],
    },
  };
}

function exiting(values: ExitAnimationsValues) {
  "worklet";
  const config = { duration: motion.medium, easing: smoothOut };

  return {
    initialValues: { height: values.currentHeight, opacity: 1, transform: [{ translateY: 0 }] },
    animations: {
      height: withTiming(0, config),
      opacity: withTiming(0, config),
      transform: [{ translateY: withTiming(motion.distance.micro, config) }],
    },
  };
}

const disclosure = { entering, exiting } satisfies Preset;
const layout = LinearTransition.duration(motion.slow).easing(smoothOut);

export function useDisclosureMotion() {
  const reduced = useReducedMotion();

  return reduced ? { entering: undefined, exiting: undefined, layout: undefined } : { ...disclosure, layout };
}
