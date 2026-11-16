import { useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button } from "../../ui/Button";
import { font, styles, useColors, useTypography } from "../../ui/theme";
import { ThreadConnectorAccess } from "./ThreadConnectorAccess";
import { ThreadConnectorRow } from "./ThreadConnectorRow";
import type { useThreadPanel } from "./use-thread-panel";

export function ThreadConnectors({
  thread,
  panel,
  disabled,
  homeName,
}: {
  thread: ui.Thread;
  panel: ReturnType<typeof useThreadPanel>;
  disabled: boolean;
  homeName: string;
}) {
  const c = useColors();
  const type = useTypography();
  const [managing, setManaging] = useState(false);
  const accounts = panel.data?.connectors.filter((account) => account.granted || account.sessionAttached) ?? [];

  const status = panel.error
    ? "Could not load connector access. Check the connection, then retry."
    : !panel.data
      ? "Loading connections…"
      : panel.data.unavailable
        ? "Connect to load connector access."
        : "";

  return (
    <View style={{ gap: 4, minWidth: 0 }}>
      <View style={[styles.row, { justifyContent: "space-between", minHeight: 44 }]}>
        <View style={[styles.row, { flex: 1, minWidth: 0 }]}>
          <Text accessibilityRole="header" style={[type.meta, { fontFamily: font.medium, color: c.muted }]}>
            Connectors
          </Text>
          {!status && !accounts.length ? <Text style={[type.meta, { color: c.muted }]}>None</Text> : null}
        </View>
        <Button
          title="Manage"
          label="Manage connector access"
          variant="text"
          size="sm"
          disabled={disabled || !panel.data}
          onPress={() => setManaging(true)}
        />
      </View>
      {status ? (
        <Text accessibilityLiveRegion="polite" style={[type.meta, { color: c.muted }]}>
          {status}
        </Text>
      ) : null}
      {panel.error ? (
        <Button title="Retry" variant="text" size="sm" onPress={() => void panel.reload().catch(() => {})} />
      ) : null}
      {accounts.map((account) => (
        <ThreadConnectorRow key={account.accountId} account={account} />
      ))}
      <ThreadConnectorAccess
        {...{ thread, panel, disabled, homeName }}
        visible={managing}
        onClose={() => setManaging(false)}
      />
    </View>
  );
}
