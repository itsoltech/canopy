import { useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button, Sheet } from "../../ui/components";
import { Switch } from "../../ui/Switch";
import { styles, useColors } from "../../ui/theme";
import { openSettingsSection } from "../settings/navigation";
import type { useThreadPanel } from "./use-thread-panel";

/** Grant edits stay worker-scoped; the gateway returns their current session status. */
export function ThreadConnectorAccess({
  thread,
  panel,
  disabled,
  homeName,
  visible,
  onClose,
}: {
  thread: ui.Thread;
  panel: ReturnType<typeof useThreadPanel>;
  disabled: boolean;
  homeName: string;
  visible: boolean;
  onClose: () => void;
}) {
  const c = useColors();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function change(account: ui.ThreadConnector, granted: boolean) {
    if (disabled || busy) return;
    setBusy(true);
    setError("");

    try {
      await panel.grant(account, granted);
    } catch {
      setError("Could not change access. Check the connection, then retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Manage connector access" visible={visible} onClose={onClose}>
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
            onClose();
            openSettingsSection("connectors");
          }}
        />
      )}
    </Sheet>
  );
}
