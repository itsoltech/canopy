import { Text, View } from "react-native";
import type { ProviderUsageWindow } from "@canopy/contracts";
import { usagePace, usageReset, usageWindowName } from "@canopy/domain/provider-usage";
import { usageTone } from "@canopy/domain/sidebar-usage";
import { styles, useColors } from "../../ui/theme";
import { usageColor } from "../navigation/usage-color";
import { useUsageTypography } from "./usage-typography";

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** A reported balance with the same steady-use reference as the web account details. */
export function UsageMeter({ window, now, showPace }: { window: ProviderUsageWindow; now: number; showPace: boolean }) {
  const c = useColors();
  const type = useUsageTypography();
  const name = usageWindowName(window.key, window.windowMinutes);
  const left = window.reached ? 0 : window.usedPercent !== undefined ? 100 - window.usedPercent : undefined;
  const pace = showPace ? usagePace(window, now) : undefined;

  const tone =
    window.reached || left === 0
      ? "danger"
      : pace
        ? pace.difference < 0
          ? "warning"
          : "neutral"
        : usageTone(window.usedPercent ?? 0);

  const paceLabel =
    !pace || pace.difference === 0
      ? "On pace"
      : pace.difference < 0
        ? `Ahead of pace · ${number.format(-pace.difference)} pp`
        : `Spare capacity · ${number.format(pace.difference)} pp`;

  const tabular = { fontVariant: ["tabular-nums" as const] };

  return (
    <View style={{ gap: 4, minWidth: 0 }}>
      <View style={[styles.row, { flexWrap: "wrap", justifyContent: "space-between", columnGap: 12, rowGap: 2 }]}>
        <Text style={[type.meta, tabular, { color: c.soft, flexShrink: 1 }]}>
          {name}
          {left !== undefined ? ` · ${number.format(left)}% left` : ""}
        </Text>
        <Text style={[type.meta, tabular, { color: c.muted, flexShrink: 1 }]}>{usageReset(window, true, now)}</Text>
      </View>
      {left !== undefined ? (
        <View style={{ paddingVertical: pace ? 4 : 0 }}>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={`${name} limit left`}
            accessibilityValue={{ min: 0, max: 100, now: Math.round(Math.max(0, Math.min(100, left))) }}
            accessibilityHint={
              pace ? `Steady-use target: ${number.format(pace.expectedLeft)}% left. ${paceLabel}` : undefined
            }
            style={{ height: 4, borderRadius: 2, backgroundColor: c.ring }}
          >
            <View
              style={{
                height: 4,
                width: `${Math.max(0, Math.min(100, left))}%`,
                borderRadius: 2,
                backgroundColor: tone === "neutral" ? c.muted : usageColor(tone, c),
              }}
            />
            {pace ? (
              <View
                style={{
                  position: "absolute",
                  top: -4,
                  left: `${pace.expectedLeft}%`,
                  height: 12,
                  width: 1,
                  backgroundColor: c.soft,
                }}
              />
            ) : null}
          </View>
        </View>
      ) : null}
      {pace ? (
        <View style={[styles.row, { flexWrap: "wrap", justifyContent: "space-between", columnGap: 12, rowGap: 0 }]}>
          <Text style={[type.meta, tabular, { color: c.muted, flexShrink: 1 }]}>
            Steady-use target: {number.format(pace.expectedLeft)}% left
          </Text>
          <Text style={[type.meta, tabular, { color: pace.difference < 0 ? c.warning : c.muted, flexShrink: 1 }]}>
            {paceLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
