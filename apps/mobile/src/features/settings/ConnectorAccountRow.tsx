import type { connectors } from "@canopy/contracts";
import { connectorAccessSummary, connectorStatus, formatRelative } from "@canopy/domain/format";
import { Pressable, Text, View } from "react-native";
import { IconButton } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { StatusDot } from "../../ui/Badge";
import { font, useColors, useTypography } from "../../ui/theme";

export function ConnectorAccountRow({
  account,
  provider,
  now,
  onPress,
  onActions,
}: {
  account: connectors.ConnectorAccount;
  provider: string;
  now: number;
  onPress: () => void;
  onActions: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const tone = account.status === "connected" ? "emerald" : account.status === "error" ? "rose" : "amber";

  const lastUsed = account.lastUsedAt
    ? `Last used ${formatRelative(account.lastUsedAt, now, "short")}`
    : "Not used yet";

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${account.name}. ${connectorStatus(account.status)}, ${provider}. ${lastUsed}. ${connectorAccessSummary(account)}`}
        accessibilityHint="Edit access"
        onPress={onPress}
        style={({ pressed }) => [
          {
            flex: 1,
            minWidth: 0,
            minHeight: 48,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            borderRadius: 8,
            backgroundColor: pressed ? c.inset : "transparent",
          },
        ]}
      >
        <Icon name="link" />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={[type.chrome, { fontFamily: font.medium, color: c.text }]}>
            {account.name}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <StatusDot tone={tone} />
            <Text numberOfLines={1} style={[type.meta, { color: c.text }]}>
              {connectorStatus(account.status)}
            </Text>
            <Text numberOfLines={1} style={[type.meta, { flex: 1, minWidth: 0, color: c.muted }]}>
              · {provider}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text numberOfLines={1} style={[type.meta, { color: c.muted }]}>
              {lastUsed}
            </Text>
            <Text numberOfLines={1} style={[type.meta, { flex: 1, minWidth: 0, color: c.muted }]}>
              {connectorAccessSummary(account)}
            </Text>
          </View>
        </View>
      </Pressable>
      <IconButton icon="ellipsis-horizontal" label={`Actions for ${account.name}`} onPress={onActions} />
    </View>
  );
}
