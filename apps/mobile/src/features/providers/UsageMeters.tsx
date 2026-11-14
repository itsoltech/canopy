import { Text, View } from "react-native";
import type { ProviderUsageSnapshot } from "@canopy/contracts";
import { activeUsageWindows, usageBillingNotice, usageReset, usageWindowName } from "@canopy/domain/provider-usage";
import { usageTone } from "@canopy/domain/sidebar-usage";
import { styles, useColors } from "../../ui/theme";
import { usageColor } from "../navigation/usage-color";

const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** Plan limit windows (web: UsageMeters): name, % used, time to reset and a 4 dp meter; nothing without data. */
export function UsageMeters({ usage, now }: { usage: ProviderUsageSnapshot | undefined; now: number }) {
  const c = useColors();
  const windows = activeUsageWindows(usage, now);
  const billing = usageBillingNotice(usage, now);

  if (!windows.length && !billing) return null;

  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      {windows.map((window) => {
        const name = usageWindowName(window.key, window.windowMinutes);

        return (
          <View key={`${window.key}:${window.windowMinutes}`} style={{ gap: 4 }}>
            <View style={[styles.row, { flexWrap: "wrap", justifyContent: "space-between", rowGap: 2 }]}>
              <Text style={[styles.overlayMeta, { color: c.soft, fontVariant: ["tabular-nums"] }]}>
                {name}
                {window.usedPercent !== undefined
                  ? ` · ${percent.format(window.usedPercent)}% used`
                  : window.reached
                    ? " · limit reached"
                    : ""}
              </Text>
              <Text style={[styles.overlayMeta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
                {usageReset(window, true, now)}
              </Text>
            </View>
            {window.usedPercent !== undefined ? (
              <View
                accessibilityRole="progressbar"
                accessibilityLabel={`${name} limit used`}
                accessibilityValue={{ min: 0, max: 100, now: Math.round(window.usedPercent) }}
                style={{ height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: c.ring }}
              >
                <View
                  style={{
                    height: 4,
                    width: `${Math.max(0, Math.min(100, window.usedPercent))}%`,
                    borderRadius: 2,
                    backgroundColor: usageColor(usageTone(window.reached ? 100 : window.usedPercent), c),
                  }}
                />
              </View>
            ) : null}
          </View>
        );
      })}
      {billing ? (
        <Text accessibilityLiveRegion="polite" style={[styles.overlayMeta, { color: c.warning }]}>
          {billing}
        </Text>
      ) : null}
    </View>
  );
}
