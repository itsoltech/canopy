import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Animated, Text, View, type StyleProp, type TextStyle } from "react-native";
import type { Tone } from "@canopy/domain/status-look";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "./Icon";
import { useReducedMotion } from "./motion";
import { font, styles, useColors } from "./theme";
import { useTone } from "./tone";

/** Small label with a tinted ring (web: Badge): an exit code, a kind, a status. Sized for work rows. */
export function Badge({
  tone = "neutral",
  icon,
  dot = false,
  children,
}: {
  tone?: Tone;
  icon?: IconName;
  /** A status: the tone's dot leads the label (web: StatusBadge). */
  dot?: boolean;
  children: ReactNode;
}) {
  const look = useTone(tone).badge;

  return (
    <View
      style={[
        styles.row,
        {
          gap: 4,
          paddingLeft: icon ? 4 : 6,
          paddingRight: 6,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: look.ring,
          backgroundColor: look.background,
        },
      ]}
    >
      {icon && <Icon name={icon} size={14} color={look.text} />}
      {dot && <StatusDot tone={tone} />}
      <Text numberOfLines={1} style={[styles.workMeta, { fontFamily: font.medium, color: look.text }]}>
        {children}
      </Text>
    </View>
  );
}

/** 6 dp status dot (web: StatusDot); always paired with text. `active` adds a soft ping, still under reduced motion. */
export function StatusDot({ tone, active = false }: { tone: Tone; active?: boolean }) {
  const color = useTone(tone).dot;
  const reduced = useReducedMotion();
  const [ping] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!active || reduced) {
      ping.setValue(0);

      return;
    }

    const loop = Animated.loop(Animated.timing(ping, { toValue: 1, duration: 1000, useNativeDriver: true }));

    loop.start();

    return () => loop.stop();
  }, [active, reduced, ping]);

  return (
    <View accessible={false} style={{ width: 6, height: 6 }}>
      {active && !reduced && (
        <Animated.View
          style={{
            position: "absolute",
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: color,
            opacity: ping.interpolate({ inputRange: [0, 1], outputRange: [0.75, 0] }),
            transform: [{ scale: ping.interpolate({ inputRange: [0, 1], outputRange: [1, 2] }) }],
          }}
        />
      )}
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
    </View>
  );
}

/** A hairline that fills the rest of a row (after a label: "Worked for …", "Forked from …"). */
export function Rule({ minWidth = 16 }: { minWidth?: number }) {
  const c = useColors();

  return <View accessible={false} style={{ flex: 1, minWidth, height: 1, backgroundColor: c.rule }} />;
}

/** The running indicator of work rows and steps (web: Spinner). */
export function Spinner({ color, size = 14 }: { color?: string; size?: number }) {
  const c = useColors();

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator size="small" color={color ?? c.sky} style={{ transform: [{ scale: size / 20 }] }} />
    </View>
  );
}

/** Text of live work (web: shimmer): breathes while it runs; still under reduced motion. */
export function LiveText({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (reduced) {
      opacity.setValue(1);

      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.45, duration: 900, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );

    loop.start();

    return () => loop.stop();
  }, [opacity, reduced]);

  return <Animated.Text style={[style, { opacity }]}>{children}</Animated.Text>;
}
