import type { ui } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { Button } from "../../ui/components";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsResource } from "./resource";

export function SharedConfiguration({ notices, onChanged }: { notices: ui.ConfigNotice[]; onChanged: () => void }) {
  const resource = useSettingsResource("configuration-notices", (api) => api.getComputers({}));
  const settings = useAppearance();

  const act = (id: string, action: string) =>
    void resource
      .run((api) => api.manageConfigNotice({ id, action }))
      .then((result) => {
        if (result) {
          onChanged();
          void settings.reload();
        }
      });

  if (!notices.length) return null;

  return (
    <ResourceState resource={resource}>
      <SettingsGroup title="Changed on two computers">
        {notices.map((notice) => (
          <SettingsRow
            key={notice.id}
            title={notice.itemName || notice.field}
            description={`${notice.nodeName} · ${notice.reason}`}
          >
            <SettingsValue title="Change" value={notice.value} />
            <SettingsActions>
              <Button
                title={notice.reason === "resurrected" ? "Delete" : "Restore"}
                disabled={resource.busy}
                onPress={() => act(notice.id, "restore")}
              />
              <Button title="Dismiss" disabled={resource.busy} onPress={() => act(notice.id, "dismiss")} />
            </SettingsActions>
          </SettingsRow>
        ))}
      </SettingsGroup>
    </ResourceState>
  );
}
