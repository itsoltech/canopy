import { Text, View } from "react-native";
import { usageReset, usageWindowName } from "@canopy/domain/provider-usage";
import type { ProxyCapacityGroup } from "@canopy/domain/proxy-capacity";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { styles, useColors, type Colors } from "../../ui/theme";
import { markProvider } from "./ProxyAccountRow";

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

const leftColor = (percentLeft: number, c: Colors) =>
  percentLeft <= 10 ? c.danger : percentLeft <= 30 ? c.warning : c.soft;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Weighted capacity of one provider's proxy accounts (web: ProxyCapacitySummary), per window: % and units left,
 * the nearest reset, a low-capacity warning and how many accounts report. All numbers come from
 * `@canopy/domain/proxy-capacity`.
 */
export function ProxyCapacitySummary({ group, now }: { group: ProxyCapacityGroup; now: number }) {
  const c = useColors();
  const meta = [styles.overlayMeta, { color: c.muted }];

  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      <View style={styles.row}>
        <ProviderIcon provider={markProvider[group.mark]} />
        <Text numberOfLines={1} style={[styles.overlayHeading, { flex: 1, color: c.text }]}>
          {group.name}
        </Text>
        <Text style={meta}>{plural(group.accounts.length, "account", "accounts")}</Text>
      </View>
      {group.windows.map((window) => {
        const name = usageWindowName(window.key, window.windowMinutes);

        return (
          <View key={`${window.key}:${window.windowMinutes}`} style={{ gap: 4 }}>
            <View style={[styles.row, { justifyContent: "space-between" }]}>
              <Text numberOfLines={1} style={[styles.overlayMeta, { flexShrink: 1, color: c.soft }]}>
                {name}
              </Text>
              <Text
                style={[styles.overlayMeta, { color: leftColor(window.percentLeft, c), fontVariant: ["tabular-nums"] }]}
              >
                {number.format(window.percentLeft)}% left
              </Text>
            </View>
            <View
              accessibilityRole="progressbar"
              accessibilityLabel={`${group.name} ${name} capacity left`}
              accessibilityValue={{ min: 0, max: 100, now: Math.round(window.percentLeft) }}
              style={{ height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: c.ring }}
            >
              <View
                style={{
                  height: 4,
                  width: `${window.percentLeft}%`,
                  borderRadius: 2,
                  backgroundColor: window.percentLeft > 30 ? c.muted : leftColor(window.percentLeft, c),
                }}
              />
            </View>
            <View style={[styles.row, { flexWrap: "wrap", justifyContent: "space-between", rowGap: 2 }]}>
              <Text style={[meta, { fontVariant: ["tabular-nums"] }]}>
                {number.format(window.remaining)} of {number.format(window.total)} units left
              </Text>
              <Text style={[meta, { fontVariant: ["tabular-nums"] }]}>{usageReset(window, true, now)}</Text>
            </View>
            {window.percentLeft <= 10 ? (
              <Text style={[styles.overlayMeta, { color: c.danger }]}>Low capacity</Text>
            ) : null}
            {window.reporting < group.accounts.length ? (
              <Text style={meta}>
                {window.reporting} of {group.accounts.length} accounts reporting
              </Text>
            ) : null}
            {window.unknown ? (
              <Text style={meta}>{plural(window.unknown, "unknown plan", "unknown plans")} counted as ×1</Text>
            ) : null}
          </View>
        );
      })}
      {!group.windows.length ? <Text style={meta}>No comparable limit readings.</Text> : null}
      {group.excluded ? (
        <Text style={meta}>{plural(group.excluded, "unavailable account", "unavailable accounts")} excluded</Text>
      ) : null}
    </View>
  );
}
