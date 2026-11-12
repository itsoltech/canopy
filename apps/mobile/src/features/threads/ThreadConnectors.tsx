import { useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button, Sheet } from "../../ui/components";
import { Switch } from "../../ui/Switch";
import { styles, useColors } from "../../ui/theme";
import { openSettingsSection } from "../settings/navigation";
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
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const accounts = panel.data?.connectors.filter((account) => account.granted) ?? [];

  async function change(account: ui.ThreadConnector, granted: boolean) {
    setBusy(true);
    setError("");

    try {
      await panel.grant(account, granted);
    } catch {
      setError("Could not change access. Reload and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={[styles.label, { color: c.text }]}>Connectors</Text>
      {accounts.map((account) => (
        <Text key={account.accountId} numberOfLines={2} style={[styles.body, { color: c.text }]}>
          {account.connectorName} · {account.accountLabel} ·{" "}
          {account.status === "connected" ? "Connected" : "Reconnect required"}
        </Text>
      ))}
      {!accounts.length && (
        <Text style={[styles.meta, { color: c.muted }]}>
          {panel.data?.unavailable
            ? "Connect to load connector access."
            : panel.data
              ? "No connectors"
              : "Loading connections…"}
        </Text>
      )}
      <Button title="Manage connector access" disabled={disabled || !panel.data} onPress={() => setManaging(true)} />
      <Sheet title="Manage connector access" visible={managing} onClose={() => setManaging(false)}>
        <Text style={[styles.meta, { color: c.muted }]}>Changes apply to every thread on this worker.</Text>
        {!!error && (
          <Text accessibilityRole="alert" style={[styles.meta, { color: c.danger }]}>
            {error}
          </Text>
        )}
        {panel.data?.connectors.map((account) => (
          <View key={account.accountId} style={[styles.row, { justifyContent: "space-between" }]}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text numberOfLines={2} style={[styles.body, { color: c.text }]}>
                {account.connectorName} · {account.accountLabel}
              </Text>
              {account.allWorkers && (
                <Text style={[styles.meta, { color: c.muted }]}>All workers · Manage on {homeName}</Text>
              )}
            </View>
            <Switch
              label={`Allow ${account.connectorName} · ${account.accountLabel}`}
              value={account.granted}
              disabled={disabled || busy || account.allWorkers || thread.status === "archived"}
              onChange={(granted) => void change(account, granted)}
            />
          </View>
        ))}
        {thread.nodeId ? (
          <Text style={[styles.meta, { color: c.muted }]}>Manage accounts on {homeName}</Text>
        ) : (
          <Button
            title="Manage accounts"
            onPress={() => {
              setManaging(false);
              openSettingsSection("connectors");
            }}
          />
        )}
      </Sheet>
    </View>
  );
}
