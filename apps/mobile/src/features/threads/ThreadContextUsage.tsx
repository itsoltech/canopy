import { useState, type ComponentProps } from "react";
import { AnimatedNumber } from "../../ui/AnimatedNumber";
import { Sheet } from "../../ui/components";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import type { ContextUsage } from "@canopy/contracts";
import { useDevicePreferences } from "../settings/device-preferences";
import { useColors, useTypography } from "../../ui/theme";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const exactTokens = (count: bigint) => count.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
const circumference = 2 * Math.PI * 7;

/** Reserve the chosen display width while waiting for the provider's first measurement. */
export function ThreadContextUsage({ usage }: { usage?: ContextUsage }) {
  const [open, setOpen] = useState(false);
  const { values } = useDevicePreferences();
  const c = useColors();
  const type = useTypography();
  const mode = values.contextDisplay;
  const used = usage?.usedTokens;
  const limit = usage?.limitTokens;
  const width = mode === "circle" ? 32 : mode === "percentage" ? 48 : 64;

  if (mode === "off") return null;

  if (used === undefined || limit === undefined || limit <= 0n) return <View style={{ width }} />;

  const percent = Number((used * 100n) / limit);
  const fill = Math.min(100, percent);
  const color = percent >= 95 ? c.danger : percent >= 80 ? c.warning : c.muted;
  const tokens = `${exactTokens(used)} of ${exactTokens(limit)} tokens used`;

  const numberProps = {
    style: [type.meta, { color, textAlign: "center" }],
    updateAnimation: "pop-in",
    numberOfLines: 1,
    adjustsFontSizeToFit: true,
  } satisfies Partial<ComponentProps<typeof AnimatedNumber>>;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Context use, ${tokens} (${percent}%)`}
        onPress={() => setOpen(true)}
        hitSlop={{ top: 6, bottom: 6 }}
        style={({ pressed }) => ({
          width,
          minHeight: 32,
          borderRadius: 6,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 4,
          backgroundColor: pressed ? c.pressed : "transparent",
        })}
      >
        {mode === "circle" ? (
          <Svg width={20} height={20} viewBox="0 0 20 20">
            <Circle cx={10} cy={10} r={7} fill="none" stroke={c.ring} strokeWidth={2} />
            <Circle
              cx={10}
              cy={10}
              r={7}
              fill="none"
              stroke={color}
              strokeWidth={2}
              transform="rotate(-90 10 10)"
              strokeDasharray={[circumference, circumference]}
              strokeDashoffset={circumference * (1 - fill / 100)}
            />
          </Svg>
        ) : mode === "bar" ? (
          <>
            <View style={{ height: 4, width: 20, borderRadius: 2, overflow: "hidden", backgroundColor: c.ring }}>
              <View style={{ height: 4, width: `${fill}%`, backgroundColor: color }} />
            </View>
            <Text numberOfLines={1} adjustsFontSizeToFit style={[type.meta, { color, flexShrink: 1 }]}>
              {percent}%
            </Text>
          </>
        ) : mode === "percentage" ? (
          <AnimatedNumber {...numberProps} value={`${percent}%`} amount={percent} />
        ) : (
          <View style={{ width, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", columnGap: 3 }}>
            <AnimatedNumber {...numberProps} value={compact.format(Number(used))} amount={used} suffix=" /" />
            <AnimatedNumber {...numberProps} value={compact.format(Number(limit))} amount={limit} />
          </View>
        )}
      </Pressable>
      {open && (
        <Sheet title={`${percent}% of context used`} visible onClose={() => setOpen(false)}>
          <Text style={[type.body, { color: c.text }]}>{tokens}</Text>
          <Text style={[type.meta, { color: c.muted }]}>Latest provider report, excluding your draft.</Text>
        </Sheet>
      )}
    </>
  );
}
