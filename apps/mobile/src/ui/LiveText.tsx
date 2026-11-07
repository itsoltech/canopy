import { useEffect, useState } from "react";
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { motion, useReducedMotion } from "./motion";
import { useColors } from "./theme";

// Narrow clipped copies approximate the web's soft linear gradient without a native mask dependency.
const slices = Array.from({ length: 24 }, (_, index) => index);
const shimmer = motion.shimmer;

interface LiveTextProps {
  children: string;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
}

/** Muted live text with the web's left-to-right sweep. Only the base text participates in layout or accessibility. */
export function LiveText({ children, style, containerStyle }: LiveTextProps) {
  const c = useColors();
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  const [width, setWidth] = useState(0);
  const [inkWidth, setInkWidth] = useState(0);
  const textStyle = [style, { color: c.muted }];

  useEffect(() => {
    cancelAnimation(progress);
    progress.set(0);

    if (!reduced) {
      // The live system subscription above owns this guard; Reanimated's default remembers startup only.
      progress.set(
        withRepeat(
          withTiming(1, { duration: shimmer.duration, easing: Easing.linear, reduceMotion: ReduceMotion.Never }),
          -1,
          false,
          undefined,
          ReduceMotion.Never,
        ),
      );
    }

    return () => cancelAnimation(progress);
  }, [progress, reduced]);

  return (
    <View style={[{ minWidth: 0, flexShrink: 1, overflow: "hidden" }, containerStyle]}>
      <Text
        numberOfLines={1}
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        onTextLayout={({ nativeEvent }) => setInkWidth(nativeEvent.lines[0]?.width ?? 0)}
        style={textStyle}
      >
        {children}
      </Text>
      {!reduced && width > 0 && inkWidth > 0 && (
        <View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={StyleSheet.absoluteFill}
        >
          {slices.map((index) => (
            <HighlightSlice
              key={index}
              index={index}
              progress={progress}
              width={width}
              inkWidth={Math.min(width, inkWidth)}
              style={[style, { color: c.shimmerHighlight }]}
            >
              {children}
            </HighlightSlice>
          ))}
        </View>
      )}
    </View>
  );
}

function HighlightSlice({
  index,
  progress,
  width,
  inkWidth,
  children,
  style,
}: LiveTextProps & { index: number; progress: SharedValue<number>; width: number; inkWidth: number }) {
  const backgroundWidth = inkWidth * shimmer.backgroundSize;
  const sliceWidth = (backgroundWidth * (shimmer.end - shimmer.start)) / slices.length;
  const stop = shimmer.start + ((index + 0.5) / slices.length) * (shimmer.end - shimmer.start);

  const opacity =
    stop < shimmer.peak
      ? (stop - shimmer.start) / (shimmer.peak - shimmer.start)
      : (shimmer.end - stop) / (shimmer.end - shimmer.peak);

  const offset = backgroundWidth * (shimmer.start - shimmer.peak) + index * sliceWidth;

  const windowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.get() * inkWidth * shimmer.travel + offset }],
  }));

  const textStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -(progress.get() * inkWidth * shimmer.travel + offset) }],
  }));

  return (
    <Animated.View
      style={[
        { position: "absolute", top: 0, bottom: 0, left: 0, width: sliceWidth, overflow: "hidden", opacity },
        windowStyle,
      ]}
    >
      <Animated.Text numberOfLines={1} style={[style, { width }, textStyle]}>
        {children}
      </Animated.Text>
    </Animated.View>
  );
}
