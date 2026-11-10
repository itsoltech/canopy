import type { ui } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { Button, Notice } from "../../ui/components";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsResource } from "./resource";

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
  const deleted = notices.filter((n) => n.reason === "deleted" && n.field === "deleted");

  const resolveAll = (action: string) =>
    void resource
      .run(async (api) => {
        for (const notice of deleted) await api.manageConfigNotice({ id: notice.id, action });

        return true;
      })
      .then(() => onChanged());

  return (
    <ResourceState resource={resource}>
      <SettingsGroup title="Changed on two computers">
        {library && (
          <Notice>
            Linked computers share library changes.
            {!!deleted.length && " Keep restores deleted items to your library. Accept deletion leaves them removed."}
          </Notice>
        )}
        {library && deleted.length > 1 && (
          <SettingsActions>
            <Button title="Keep all deleted items" disabled={resource.busy} onPress={() => resolveAll("restore")} />
            <Button title="Accept all deletions" disabled={resource.busy} onPress={() => resolveAll("dismiss")} />
          </SettingsActions>
        )}
        {notices.map((notice) => (
          <SettingsRow
            key={notice.id}
            title={notice.itemName || notice.field}
            description={
              notice.reason === "deleted" ? `Deleted on ${notice.nodeName}.` : `${notice.nodeName} · ${notice.reason}`
            }
          >
            <SettingsValue title="Change" value={notice.value} />
            <SettingsActions>
              <Button
                title={
                  notice.reason === "resurrected"
                    ? "Delete"
                    : library && notice.reason === "deleted"
                      ? "Keep"
                      : "Restore"
                }
                disabled={resource.busy}
                onPress={() => act(notice.id, "restore")}
              />
              <Button
                title={library && notice.reason === "deleted" ? "Accept deletion" : "Dismiss"}
                disabled={resource.busy}
                onPress={() => act(notice.id, "dismiss")}
              />
            </SettingsActions>
          </SettingsRow>
        ))}
      </SettingsGroup>
    </ResourceState>
  );
}
