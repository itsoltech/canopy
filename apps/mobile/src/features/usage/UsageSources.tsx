import { Text, View } from "react-native";
import { dayLabel, type UsageData } from "@canopy/domain/usage-report";
import { Notice } from "../../ui/components";
import { font, useColors, useTypography } from "../../ui/theme";

const statuses = new Map([
  ["ready", "Ready"],
  ["syncing", "Syncing"],
  ["unsupported", "Needs update"],
  ["relay", "Direct connection needed"],
  ["stale", "Sync delayed"],
  ["offline", "Offline"],
]);

export function UsageSources({ computers }: { computers: UsageData["computers"] }) {
  const c = useColors();
  const type = useTypography();

  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={[type.body, { fontFamily: font.semibold, color: c.text }]}>
        Recording sources
      </Text>
      {computers.length === 0 && <Notice>No recording sources available.</Notice>}
      {computers.map(({ id, name, status, trackingSince }) => (
        <View key={id} style={{ gap: 2 }}>
          <Text selectable style={[type.small, { color: c.text }]}>
            {name}
          </Text>
          <Text style={[type.small, { color: c.muted }]}>
            {statuses.get(status) ?? "Unknown status"}
            {trackingSince ? ` · Recording since ${dayLabel(trackingSince.slice(0, 10), true)}` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}
