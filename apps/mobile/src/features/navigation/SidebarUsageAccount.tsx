import { Text, View } from "react-native";
import { activeUsageWindows, usageBillingNotice, usageReset, usageWindowName } from "@canopy/domain/provider-usage";
import { usageTone, type SidebarUsageAccount as Account } from "@canopy/domain/sidebar-usage";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { styles, useColors } from "../../ui/theme";
import { usageColor } from "./usage-color";

export function SidebarUsageAccount({ account, now }: { account: Account; now: number }) {
  const c = useColors();
  const billing = usageBillingNotice(account.usage, now);

  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      <View style={styles.row}>
        <ProviderIcon provider={account.provider} />
        <Text numberOfLines={1} style={[styles.overlayHeading, { color: c.text, flex: 1 }]}>
          {account.label}
        </Text>
        <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.muted, maxWidth: "40%" }]}>
          {account.computer}
        </Text>
      </View>
      {activeUsageWindows(account.usage, now).map((window) => (
        <View key={window.key} style={{ gap: 4 }}>
          <View style={[styles.row, { flexWrap: "wrap", justifyContent: "space-between" }]}>
            <Text style={[styles.overlayMeta, { color: c.soft }]}>
              {usageWindowName(window.key)}
              {window.usedPercent !== undefined
                ? ` · ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(window.usedPercent)}% used`
                : window.reached
                  ? " · limit reached"
                  : ""}
            </Text>
            <Text style={[styles.overlayMeta, { color: c.muted }]}>{usageReset(window, true, now)}</Text>
          </View>
          {window.usedPercent !== undefined ? (
            <View
              accessibilityRole="progressbar"
              accessibilityLabel={`${usageWindowName(window.key)} limit used`}
              accessibilityValue={{ min: 0, max: 100, now: window.usedPercent }}
              style={{ height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: c.ring }}
            >
              <View
                style={{
                  height: 4,
                  width: `${window.usedPercent}%`,
                  borderRadius: 2,
                  backgroundColor: usageColor(usageTone(window.reached ? 100 : window.usedPercent), c),
                }}
              />
            </View>
          ) : null}
        </View>
      ))}
      {billing ? (
        <Text accessibilityLiveRegion="polite" style={[styles.overlayMeta, { color: c.warning }]}>
          {billing}
        </Text>
      ) : null}
    </View>
  );
}
