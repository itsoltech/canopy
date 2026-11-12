import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { LayoutAnimationConfig, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { motion, smoothOut, useMotion, useReducedMotion } from "./motion";
import { Swap } from "./MotionViews";
import { font, styles, useColors, useTypography } from "./theme";

const GAP = 2;

/**
 * Segments with a raised pill that slides to the selected one (web sliding tabs, `t-tabs-pill`: `fast`,
 * `smoothOut`; instant with reduced motion). Until the track is measured the selected segment raises itself.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  style,
  compact = false,
}: {
  /** `badge`: a count beside the label of a segment that is not selected (unread items there). */
  options: readonly { value: T; label: string; badge?: number; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const c = useColors();
  const type = useTypography();
  const reduced = useReducedMotion();
  const [track, setTrack] = useState(0);

  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const segment = track ? (track - GAP * (options.length - 1)) / options.length : 0;
  const x = useSharedValue(0);
  const laidOut = useRef(0);
  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));

  useEffect(() => {
    const target = index * (segment + GAP);
    // A new width (rotation, a resized window) moves the pill at once; only a new selection slides it.
    const resized = laidOut.current !== segment;
    laidOut.current = segment;
    x.set(resized || reduced ? target : withTiming(target, { duration: motion.fast, easing: smoothOut }));
  }, [index, segment, reduced, x]);

  const raised: ViewStyle = {
    borderRadius: 6,
    backgroundColor: c.dark ? "#ffffff1a" : "#ffffff",
    ...(!c.dark && {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.ring,
      shadowColor: "#000000",
      shadowOpacity: 0.05,
      shadowRadius: 1,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    }),
  };

  return (
    <View
      onLayout={(event) => setTrack(event.nativeEvent.layout.width - GAP * 2)}
      style={[styles.row, { backgroundColor: c.recess, padding: GAP, gap: GAP, borderRadius: 8 }, style]}
    >
      {segment > 0 && (
        <Animated.View
          pointerEvents="none"
          style={[raised, { position: "absolute", top: GAP, bottom: GAP, left: GAP, width: segment }, pill]}
        />
      )}
      <LayoutAnimationConfig skipEntering>
        {options.map((option) => (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: value === option.value, disabled: option.disabled }}
            disabled={option.disabled}
            onPress={() => onChange(option.value)}
            hitSlop={{ top: 6, bottom: 6 }}
            style={[
              {
                flex: 1,
                minHeight: compact ? 28 : 32,
                paddingHorizontal: compact ? 8 : 12,
                paddingVertical: compact ? 4 : 6,
                alignItems: "center",
                justifyContent: "center",
                opacity: option.disabled ? 0.4 : 1,
              },
              value === option.value && !segment && raised,
            ]}
          >
            {/* The badge sits beside the label, outside its flow: the label stays put when it appears. */}
            <View>
              <Text
                style={[
                  compact ? type.meta : type.small,
                  { fontFamily: font.medium, color: value === option.value ? c.text : c.muted },
                ]}
              >
                {option.label}
              </Text>
              {value !== option.value && !!option.badge && <SegmentBadge count={option.badge} />}
            </View>
          </Pressable>
        ))}
      </LayoutAnimationConfig>
    </View>
  );
}

/** An unread count that pops in beside its label and swaps its number as it changes (web `pop`, `swap`). */
function SegmentBadge({ count }: { count: number }) {
  const c = useColors();
  const { pop } = useMotion();
  const label = count > 99 ? "99+" : String(count);

  return (
    <Animated.View
      entering={pop.entering}
      exiting={pop.exiting}
      accessibilityLabel={`${count} unread`}
      style={{ position: "absolute", left: "100%", top: 0, bottom: 0, marginLeft: 6, justifyContent: "center" }}
    >
      <View style={{ borderRadius: 999, overflow: "hidden", backgroundColor: c.accent, paddingHorizontal: 6 }}>
        <Swap value={label}>
          <Text style={[styles.caption, { color: c.onAccent, fontVariant: ["tabular-nums"] }]}>{label}</Text>
        </Swap>
      </View>
    </Animated.View>
  );
}
