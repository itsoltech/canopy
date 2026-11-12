import { useEffect } from "react";
import Svg, { Circle, Path } from "react-native-svg";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { threadSpinner } from "@canopy/ui/thread-row";
import { motion, useReducedMotion } from "./motion";
import { useAppActive } from "./active";

/** Decorative web ring. Only rotation runs each frame, on the UI thread; reduced motion keeps the ring still. */
export function WorkingSpinner({ color, size = 16 }: { color: string; size?: number }) {
  const reduced = useReducedMotion();
  const active = useAppActive();
  const rotation = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(rotation);
    rotation.set(0);

    if (active && !reduced) {
      rotation.set(
        withRepeat(
          withTiming(360, { duration: motion.spin, easing: Easing.linear, reduceMotion: ReduceMotion.Never }),
          -1,
          false,
          undefined,
          ReduceMotion.Never,
        ),
      );
    }

    return () => cancelAnimation(rotation);
  }, [rotation, active, reduced]);

  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.get()}deg` }] }));

  return (
    <Animated.View accessible={false} style={[{ width: size, height: size }, style]}>
      <Svg
        width={size}
        height={size}
        viewBox={threadSpinner.viewBox}
        fill="none"
        stroke={color}
        strokeWidth={threadSpinner.strokeWidth}
      >
        <Circle
          cx={threadSpinner.center}
          cy={threadSpinner.center}
          r={threadSpinner.radius}
          opacity={threadSpinner.trackOpacity}
        />
        <Path d={threadSpinner.path} strokeLinecap="round" />
      </Svg>
    </Animated.View>
  );
}
