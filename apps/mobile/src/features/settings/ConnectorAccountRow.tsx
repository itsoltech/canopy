import type { connectors } from "@canopy/contracts";
import { connectorAccessSummary, connectorStatus, formatAge } from "@canopy/domain/format";
import { Pressable, Text, View } from "react-native";
import { IconButton } from "../../ui/components";
import { Icon } from "../../ui/Icon";
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
  const color = account.status === "connected" ? c.success : account.status === "error" ? c.danger : c.warning;
  const lastUsed = account.lastUsedAt ? `Last used ${formatAge(account.lastUsedAt, now)}` : "Not used yet";

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${account.name}, ${provider}. ${connectorStatus(account.status)}. This computer. ${lastUsed}. ${connectorAccessSummary(account)}`}
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
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text numberOfLines={1} style={[type.chrome, { flex: 1, fontFamily: font.medium, color: c.text }]}>
              {account.name}
            </Text>
            <Text numberOfLines={1} style={[type.meta, { maxWidth: "40%", color: c.muted }]}>
              {provider}
            </Text>
          </View>
          <Text numberOfLines={1} style={[type.meta, { color }]}>
            {connectorStatus(account.status)} · This computer
          </Text>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text numberOfLines={1} style={[type.meta, { flex: 1, color: c.muted }]}>
              {lastUsed}
            </Text>
            <Text numberOfLines={1} style={[type.meta, { maxWidth: "60%", color: c.muted }]}>
              {connectorAccessSummary(account)}
            </Text>
          </View>
        </View>
      </Pressable>
      <IconButton icon="ellipsis-horizontal" label={`Actions for ${account.name}`} onPress={onActions} />
    </View>
  );
}
