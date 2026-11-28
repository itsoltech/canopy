import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { LayoutAnimationConfig, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { motion, smoothOut, useMotion, useReducedMotion } from "./motion";
import { AnimatedNumber } from "./AnimatedNumber";
import { font, styles, useColors, useTypography } from "./theme";
import { WorkingSpinner } from "./WorkingSpinner";

const GAP = 2;

// The sidebar's 272 dp breakpoint minus its 12 dp gutters and the track padding.
const NARROW_TRACK = 244;

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
  inactiveColor,
}: {
  /** `badge`: a count beside the label of a segment that is not selected (unread items there). */
  options: readonly {
    value: T;
    label: string;
    badge?: number;
    working?: number;
    attention?: boolean;
    disabled?: boolean;
  }[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
  inactiveColor?: string;
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
    }),
  };

  return (
    <View
      onLayout={(event) => setTrack(event.nativeEvent.layout.width - GAP * 2)}
      style={[styles.row, { backgroundColor: c.recess, padding: GAP, gap: GAP, borderRadius: 8 }, style]}
    >
      {segment > 0 && (
        // Android elevation would draw the moving pill over the tab labels.
        <Animated.View
          pointerEvents="none"
          style={[raised, { position: "absolute", top: GAP, bottom: GAP, left: GAP, width: segment }, pill]}
        />
      )}
      <LayoutAnimationConfig skipEntering>
        {options.map((option) => {
          const selected = value === option.value;
          const unread = selected ? 0 : (option.badge ?? 0);
          const working = option.working ?? 0;
          const attention = !selected && !unread && option.attention;

          return (
            <Pressable
              key={option.value}
              accessibilityRole="tab"
              accessibilityLabel={`${option.label}${working ? `, ${working} working` : ""}${unread ? `, ${unread} unread` : attention ? ", needs you" : ""}`}
              accessibilityState={{ selected, disabled: option.disabled }}
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
                selected && !segment && raised,
              ]}
            >
              {/* The badge sits beside the label, outside its flow: the label stays put when it appears. */}
              <View>
                {working > 0 && <SegmentWorking count={working} narrow={track <= NARROW_TRACK} />}
                <Text
                  style={[
                    compact ? type.meta : type.small,
                    { fontFamily: font.medium, color: selected ? c.text : (inactiveColor ?? c.muted) },
                  ]}
                >
                  {option.label}
                </Text>
                {!!unread && <SegmentBadge count={unread} />}
                {attention && (
                  <View style={marker.trailing}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.warning }} />
                  </View>
                )}
              </View>
            </Pressable>
          );
        })}
      </LayoutAnimationConfig>
    </View>
  );
}

/** The badge handles its entrance and exit. Only its digits move while it stays visible. */
function SegmentBadge({ count }: { count: number }) {
  const c = useColors();
  const { pop } = useMotion();
  const label = count > 99 ? "99+" : String(count);

  return (
    <Animated.View entering={pop.entering} exiting={pop.exiting} style={marker.trailing}>
      <View style={{ borderRadius: 999, overflow: "hidden", backgroundColor: c.accent, paddingHorizontal: 6 }}>
        <AnimatedNumber
          value={label}
          amount={count}
          animateOnMount={false}
          style={[styles.caption, { color: c.onAccent }]}
        />
      </View>
    </Animated.View>
  );
}

function SegmentWorking({ count, narrow }: { count: number; narrow: boolean }) {
  const c = useColors();
  const { pop } = useMotion();
  const label = count > 99 ? "99+" : String(count);
  const width = narrow ? 12 : 48;

  return (
    <Animated.View entering={pop.entering} exiting={pop.exiting} style={[marker.leading, { width, left: -width - 4 }]}>
      <WorkingSpinner size={narrow ? 12 : 14} color={c.working.indicator} />
      {!narrow && (
        <AnimatedNumber
          value={label}
          amount={count}
          animateOnMount={false}
          style={[styles.caption, { color: c.working.text }]}
        />
      )}
    </Animated.View>
  );
}

const marker = StyleSheet.create({
  leading: {
    position: "absolute",
    top: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 2,
  },
  // Give Yoga room to measure the badge outside the label, just like the leading spinner.
  trailing: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: -54,
    width: 48,
    alignItems: "flex-start",
    justifyContent: "center",
  },
});
