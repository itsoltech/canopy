import type { ui } from "@canopy/contracts";
import { Button } from "../../ui/components";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsResource } from "./resource";

export function SharedConfiguration({ notices, onChanged }: { notices: ui.ConfigNotice[]; onChanged: () => void }) {
  const resource = useSettingsResource("configuration-notices", (api) => api.getComputers({}));

  const act = (id: string, action: string) =>
    void resource.run((api) => api.manageConfigNotice({ id, action })).then(onChanged);

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
            <Button
              secondary
              title={notice.reason === "resurrected" ? "Delete" : "Restore"}
              disabled={resource.busy}
              onPress={() => act(notice.id, "restore")}
            />
            <Button secondary title="Dismiss" disabled={resource.busy} onPress={() => act(notice.id, "dismiss")} />
          </SettingsRow>
        ))}
      </SettingsGroup>
    </ResourceState>
  );
}
