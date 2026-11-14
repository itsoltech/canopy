import { Text, View } from "react-native";
import type { SidebarUsageAccount as Account } from "@canopy/domain/sidebar-usage";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { styles, useColors } from "../../ui/theme";
import { UsageMeters } from "../providers/UsageMeters";

export function SidebarUsageAccount({ account, now }: { account: Account; now: number }) {
  const c = useColors();

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
      <UsageMeters usage={account.usage} now={now} />
    </View>
  );
}
