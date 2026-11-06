import { Text } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button } from "../../ui/components";
import { styles, useColors, useTypography } from "../../ui/theme";
import { providerName } from "../models/catalog";
import { SettingsRow, SettingsActions } from "./SettingsGroup";
import { SettingsDisclosure } from "./SettingsDisclosure";

export function WorkerCliRow({
  item,
  disabled,
  onInstall,
}: {
  item: ui.WorkerCliTool;
  disabled: boolean;
  onInstall: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const installing = item.tool?.install?.state === "running";
  const manual = !item.action && item.tool?.manualCommand;

  return (
    <SettingsRow
      title={`${providerName(item.tool?.provider ?? 0)} · ${item.tool?.version || "Not installed"}`}
      description={[
        item.tool?.path,
        item.tool?.detail,
        item.managedBy,
        item.blockedReason,
        item.latest?.error,
        item.tool?.versionError,
        item.tool?.install?.error,
      ]
        .filter(Boolean)
        .join(" · ")}
      control={
        item.action ? (
          <SettingsActions>
            <Button
              secondary
              title={item.action === "install" ? "Install" : "Update"}
              disabled={disabled || !!item.blockedReason || installing}
              busy={installing}
              onPress={onInstall}
            />
          </SettingsActions>
        ) : undefined
      }
    >
      {manual ? (
        <Text
          selectable
          accessibilityLabel="Run on this computer"
          style={[type.mono, { padding: 8, borderRadius: 6, color: c.text, backgroundColor: c.inset }]}
        >
          {manual}
        </Text>
      ) : null}
      {!!item.tool?.alternatives.length && (
        <SettingsDisclosure title={`Other copies (${item.tool.alternatives.length})`}>
          {item.tool.alternatives.map((alternative) => (
            <Text key={alternative.path} selectable style={[styles.workMeta, { color: c.muted }]}>
              {alternative.path}
              {alternative.version ? ` · ${alternative.version}` : ""}
            </Text>
          ))}
        </SettingsDisclosure>
      )}
      {!!item.log.length && (
        <SettingsDisclosure
          title={installing ? "Installer output" : "Last installer output"}
          initiallyOpen={installing}
        >
          <Text selectable style={[styles.workMeta, { color: c.muted }]}>
            {item.log.join("\n")}
          </Text>
        </SettingsDisclosure>
      )}
    </SettingsRow>
  );
}
