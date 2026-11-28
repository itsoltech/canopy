import { useCallback, useLayoutEffect, useState } from "react";
import { StyleSheet, Text, View, type StyleProp, type TextProps, type TextStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { motion, smoothOut, useReducedMotion } from "./motion";

interface Reading {
  value: string;
  amount?: number | bigint;
}

interface Props extends Reading, Pick<TextProps, "selectable" | "numberOfLines" | "accessibilityLiveRegion"> {
  prefix?: string;
  suffix?: string;
  style?: StyleProp<TextStyle>;
  animateOnMount?: boolean;
}

const digit = /\p{Nd}/u;

// Android Fabric reserves packed color 0 for inheritance. Transparent white keeps a real foreground span.
const hidden = { color: "#ffffff00" };

function transition(next: Reading, previous?: Reading) {
  const characters = Array.from(next.value);
  const lastDigit = characters.findLastIndex((character) => digit.test(character));
  const old = Array.from(previous?.value ?? "");
  const shape = (value: string) => value.replace(/\p{Nd}/gu, "0");
  const sameShape = previous && shape(next.value) === shape(previous.value);
  // Integer counters can grow a place (9% → 10%). Match their units from the right.
  const integer = /^\p{Nd}+%?$/u;
  const alignUnits = previous && integer.test(previous.value) && integer.test(next.value);

  const slots = characters.map((character, index) => {
    const before = sameShape ? old[index] : alignUnits ? old[old.length - characters.length + index] : undefined;
    const changed = digit.test(character) && character !== before;
    const group = changed ? (previous ? 0 : Math.max(0, 2 + index - lastDigit)) : -1;

    return { character, before, group };
  });

  const groups = [...new Set(slots.map((slot) => slot.group).filter((group) => group >= 0))];

  if (!groups.length) return undefined;

  return {
    slots,
    groups,
    opening: !previous,
    direction: previous?.amount !== undefined && next.amount !== undefined && next.amount < previous.amount ? -1 : 1,
  };
}

type Transition = NonNullable<ReturnType<typeof transition>>;

/** Every layer uses the same native text layout, including wrapping, currency placement and inline prose. */
function maskedValue(change: Transition, group: number, prefix: string, suffix: string, outgoing = false) {
  const literal = group === -1 ? undefined : hidden;

  return (
    <>
      {prefix && <Text style={literal}>{prefix}</Text>}
      {change.slots.map(({ character, before, group: slot }, index) => {
        const visible = group === slot && (!outgoing || before !== undefined);

        return (
          <Text key={index} style={visible ? undefined : hidden}>
            {outgoing && visible ? before : character}
          </Text>
        );
      })}
      {suffix && <Text style={literal}>{suffix}</Text>}
    </>
  );
}

interface LayerProps extends Pick<Props, "style" | "numberOfLines"> {
  change: Transition;
  prefix: string;
  suffix: string;
}

function DigitLayer({
  change,
  style,
  prefix,
  suffix,
  elapsed,
  numberOfLines,
  group,
  outgoing = false,
}: LayerProps & { elapsed: SharedValue<number>; group: number; outgoing?: boolean }) {
  const { opening, direction } = change;
  const em = StyleSheet.flatten(style)?.fontSize ?? 14;

  const animated = useAnimatedStyle(() => {
    const progress = Math.min(
      1,
      Math.max(0, (elapsed.get() - group * motion.stagger) / (opening ? motion.verySlow : motion.slow)),
    );

    const eased = smoothOut(progress);

    if (opening) {
      const split = 0.48;

      const offset =
        progress < split
          ? 0.52 - 0.565 * smoothOut(progress / split)
          : -0.045 * (1 - smoothOut((progress - split) / (1 - split)));

      return { opacity: Math.min(1, eased / split), transform: [{ translateY: em * offset }] };
    }

    return {
      opacity: outgoing ? 1 - eased : eased,
      transform: [{ translateY: 0.14 * em * direction * (outgoing ? -eased : 1 - eased) }],
    };
  });

  return (
    <Animated.Text accessible={false} numberOfLines={numberOfLines} style={[styles.layer, style, animated]}>
      {maskedValue(change, group, prefix, suffix, outgoing)}
    </Animated.Text>
  );
}

function DigitLayers({ change, onFinish, ...props }: LayerProps & { onFinish: () => void }) {
  const elapsed = useSharedValue(0);
  const duration = change.opening ? motion.verySlow + Math.max(...change.groups) * motion.stagger : motion.slow;

  useLayoutEffect(() => {
    elapsed.set(
      withTiming(duration, { duration, easing: Easing.linear, reduceMotion: ReduceMotion.Never }, (finished) => {
        if (finished) scheduleOnRN(onFinish);
      }),
    );

    return () => cancelAnimation(elapsed);
  }, [elapsed, duration, onFinish]);

  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      {!change.opening && change.slots.some(({ before, group }) => group >= 0 && before !== undefined) && (
        <DigitLayer {...props} change={change} group={0} elapsed={elapsed} outgoing />
      )}
      {change.groups.map((group) => (
        <DigitLayer key={group} {...props} change={change} group={group} elapsed={elapsed} />
      ))}
    </View>
  );
}

export function AnimatedNumber({
  value,
  amount,
  prefix = "",
  suffix = "",
  style,
  selectable,
  numberOfLines,
  accessibilityLiveRegion,
  animateOnMount = true,
}: Props) {
  const reduced = useReducedMotion();

  const [reading, setReading] = useState(() => ({
    value,
    amount,
    change: !reduced && animateOnMount ? transition({ value, amount }) : undefined,
  }));

  if (value !== reading.value) {
    setReading({ value, amount, change: reduced ? undefined : transition({ value, amount }, reading) });
  } else if (reduced && reading.change) {
    setReading({ value, amount, change: undefined });
  }

  const change = reading.change;

  const finish = useCallback(() => {
    setReading((current) => (current.change === change ? { ...current, change: undefined } : current));
  }, [change]);

  const textStyle = [styles.number, style];

  return (
    <View>
      <Text
        selectable={selectable}
        numberOfLines={numberOfLines}
        accessibilityLiveRegion={accessibilityLiveRegion}
        style={textStyle}
      >
        {change ? maskedValue(change, -1, prefix, suffix) : prefix + value + suffix}
      </Text>
      {change && (
        <DigitLayers
          key={value}
          change={change}
          numberOfLines={numberOfLines}
          style={textStyle}
          prefix={prefix}
          suffix={suffix}
          onFinish={finish}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  number: { fontVariant: ["tabular-nums"] },
  layer: { position: "absolute", top: 0, left: 0, right: 0 },
});
