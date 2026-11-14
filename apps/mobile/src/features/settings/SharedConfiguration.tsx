import type { ui } from "@canopy/contracts";
import { configNotice } from "@canopy/domain/config-notice";
import { Text } from "react-native";
import { useAppearance } from "../../state/appearance";
import { Button, Notice } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { ResourceState, useSettingsAction, useSettingsResource } from "./resource";
import { useDevicePreferences } from "./device-preferences";

export function SharedConfiguration({
  notices,
  onChanged,
  library = false,
}: {
  notices: ui.ConfigNotice[];
  onChanged: () => void;
  library?: boolean;
}) {
  const resource = useSettingsResource("GetComputers", (api) => api.getComputers({}));
  const settings = useAppearance();

  const action = useSettingsAction(
    resource,
    "Could not apply this value on this computer. Try again, or change it in its settings.",
  );

  const act = (ids: string[], operation: "restore" | "dismiss") =>
    void action.run(async (api) => {
      try {
        for (const id of ids) await api.manageConfigNotice({ id, action: operation });

        return true;
      } finally {
        // Bulk resolution can succeed for some items before another fails.
        onChanged();
        void settings.reload();
      }
    });

  if (!notices.length) return null;
  const deleted = notices.filter((n) => n.reason === "deleted" && n.field === "deleted");

  return (
    <ResourceState resource={{ ...resource, ...action }}>
      <SettingsGroup title="Changed on two computers">
        {library && (
          <Notice>
            Linked computers share library changes.
            {!!deleted.length && " Keep restores deleted items to your library. Accept deletion leaves them removed."}
          </Notice>
        )}
        {library && deleted.length > 1 && (
          <SettingsActions>
            <Button
              title="Keep all deleted items"
              disabled={action.busy}
              onPress={() =>
                act(
                  deleted.map((n) => n.id),
                  "restore",
                )
              }
            />
            <Button
              title="Accept all deletions"
              disabled={action.busy}
              onPress={() =>
                act(
                  deleted.map((n) => n.id),
                  "dismiss",
                )
              }
            />
          </SettingsActions>
        )}
        {notices.map((notice) => (
          <ConfigNoticeRow
            key={notice.id}
            notice={notice}
            library={library}
            busy={action.busy}
            onAction={(operation) => act([notice.id], operation)}
          />
        ))}
      </SettingsGroup>
    </ResourceState>
  );
}

function ConfigNoticeRow({
  notice,
  library,
  busy,
  onAction,
}: {
  notice: ui.ConfigNotice;
  library: boolean;
  busy: boolean;
  onAction: (action: "restore" | "dismiss") => void;
}) {
  const settings = useAppearance();
  const { values } = useDevicePreferences();
  const c = useColors();
  const type = useTypography();

  const time = new Date(Number(notice.changedAtMs)).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: values.timeFormat === "system" ? undefined : values.timeFormat === "12h",
    timeZone: settings.user?.timezone || undefined,
  });

  const row = configNotice(notice, time, { library });

  return (
    <SettingsRow title={row.title} description={row.message}>
      {!!row.value && (
        <Text selectable style={[type.meta, { color: c.soft }]}>
          {row.value}
        </Text>
      )}
      <SettingsActions>
        <Button title={row.restore} style={{ maxWidth: "100%" }} disabled={busy} onPress={() => onAction("restore")} />
        <Button
          title={row.dismiss}
          style={{ maxWidth: "100%" }}
          variant="ghost"
          disabled={busy}
          onPress={() => onAction("dismiss")}
        />
      </SettingsActions>
    </SettingsRow>
  );
}
