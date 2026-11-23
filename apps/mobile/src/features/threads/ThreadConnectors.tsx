import { useState } from "react";
import { Text } from "react-native";
import type { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { Button } from "../../ui/Button";
import { useColors, useTypography } from "../../ui/theme";
import { ThreadConnectorAccess } from "./ThreadConnectorAccess";
import { ThreadConnectorRow } from "./ThreadConnectorRow";
import type { useThreadPanel } from "./use-thread-panel";
import { ThreadPanelSection } from "./ThreadPanelSection";

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
  const { projects } = useOverview();
  const project = projects.find((candidate) => candidate.id === thread.projectId);
  const noProject = project?.kind === "scratch";
  const accounts = panel.data?.connectors.filter((account) => account.granted || account.sessionAttached) ?? [];

  const status = panel.error
    ? "Could not load connector access. Check the connection, then retry."
    : !panel.data
      ? "Loading connections…"
      : panel.data.unavailable
        ? "Connect to load connector access."
        : "";

  return (
    <ThreadPanelSection
      title="Connectors"
      action={
        <Button
          title={noProject ? "View access" : "Manage"}
          label={noProject ? "View access" : "Manage connector access"}
          variant="text"
          size="sm"
          disabled={disabled || !panel.data}
          onPress={() => setManaging(true)}
        />
      }
    >
      {status ? (
        <Text accessibilityLiveRegion="polite" style={[type.meta, { color: c.muted }]}>
          {status}
        </Text>
      ) : null}
      {!status && !accounts.length && noProject && (
        <Text accessibilityLiveRegion="polite" style={[type.meta, { color: c.muted }]}>
          No accounts have access in No project.
        </Text>
      )}
      {panel.error ? (
        <Button title="Retry" variant="text" size="sm" onPress={() => void panel.reload().catch(() => {})} />
      ) : null}
      {accounts.map((account) => (
        <ThreadConnectorRow key={account.accountId} account={account} />
      ))}
      <ThreadConnectorAccess
        {...{ thread, project, panel, disabled, homeName }}
        visible={managing}
        onClose={() => setManaging(false)}
      />
    </ThreadPanelSection>
  );
}
