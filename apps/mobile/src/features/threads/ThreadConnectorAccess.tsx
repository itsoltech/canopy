import { useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button, Sheet } from "../../ui/components";
import { Switch } from "../../ui/Switch";
import { styles, useColors } from "../../ui/theme";
import { useOpenSettingsSection } from "../settings/navigation";
import type { useThreadPanel } from "./use-thread-panel";

/** The gateway returns the current session status after each project grant edit. */
export function ThreadConnectorAccess({
  thread,
  project,
  panel,
  disabled,
  homeName,
  visible,
  onClose,
}: {
  thread: ui.Thread;
  project: ui.Project | undefined;
  panel: ReturnType<typeof useThreadPanel>;
  disabled: boolean;
  homeName: string;
  visible: boolean;
  onClose: () => void;
}) {
  const c = useColors();
  const noProject = project?.kind === "scratch";
  const openSettingsSection = useOpenSettingsSection();
  const hasProject = project?.kind === "project" && !project.archivedAt;
  const accounts = panel.data?.connectors.filter((account) => account.revision > 0n) ?? [];
  const hasLegacyGrants = accounts.some((account) => account.allProjects === undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function change(account: ui.ThreadConnector, granted: boolean) {
    if (disabled || busy || !hasProject || account.allProjects !== false || thread.status === "archived") return;
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
    <Sheet title={noProject ? "Connector access" : "Manage connector access"} visible={visible} onClose={onClose}>
      <Text style={[styles.meta, { color: c.muted }]}>
        {noProject
          ? "Access applies to every thread in No project."
          : hasProject
            ? "Changes apply to every thread in this project."
            : "This thread has no active project."}
      </Text>
      {!!error && (
        <Text accessibilityRole="alert" style={[styles.meta, { color: c.danger }]}>
          {error}
        </Text>
      )}
      {hasProject && hasLegacyGrants ? (
        <Text style={[styles.meta, { color: c.muted }]}>Update the gateway to manage project access.</Text>
      ) : null}
      {!accounts.length && <Text style={[styles.meta, { color: c.muted }]}>No connector accounts</Text>}
      {accounts.map((account) => (
        <View key={account.accountId} style={[styles.row, { justifyContent: "space-between" }]}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text numberOfLines={2} style={[styles.body, { color: c.text }]}>
              {account.connectorName} · {account.accountLabel}
            </Text>
            {noProject ? (
              <Text style={[styles.meta, { color: c.muted }]}>{account.granted ? "Access granted" : "No access"}</Text>
            ) : (
              account.allProjects && <Text style={[styles.meta, { color: c.muted }]}>All projects</Text>
            )}
          </View>
          {!noProject && (
            <Switch
              label={`Allow ${account.connectorName} · ${account.accountLabel}`}
              value={account.granted}
              disabled={
                disabled || busy || !hasProject || account.allProjects !== false || thread.status === "archived"
              }
              onChange={(granted) => void change(account, granted)}
            />
          )}
        </View>
      ))}
      {thread.nodeId ? (
        <Text style={[styles.meta, { color: c.muted }]}>
          {noProject ? `Open Settings → Connectors on “${homeName}”.` : `Manage accounts on ${homeName}`}
        </Text>
      ) : (
        <Button
          title={noProject ? "Open connector settings" : "Manage accounts"}
          onPress={() => {
            onClose();
            openSettingsSection("connectors");
          }}
        />
      )}
    </Sheet>
  );
}
