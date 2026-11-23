import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Button } from "../../ui/components";
import { ResetSetting } from "./ResetSetting";
import { SettingChoice, SettingsGroup } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";

export function ProjectWorktreeDefaults({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const resource = useSettingsResource(`GetWorktreeSettings:${projectId}:`, (api) =>
    api.getWorktreeSettings({ projectId, workerId: "" }),
  );

  const data = resource.data;

  const update = (defaultMode: ui.WorkspaceMode) =>
    data &&
    void resource.run((api) =>
      api.updateWorktreeSettings({
        projectId,
        expectedVersion: data.version,
        settings: create(ui.WorktreeSettingsSchema, {
          ...create(ui.WorktreeSettingsSchema, data.settings),
          defaultMode,
        }),
      }),
    );

  return (
    <ResourceState resource={resource}>
      <SettingsGroup
        title="Worktrees"
        description="Where new threads in this project start, on every computer."
        actions={<Button title="Worktree settings" size="sm" onPress={onOpen} />}
      >
        <SettingChoice
          title="Default workspace"
          description="You can choose a different workspace for each thread."
          value={data?.effective?.defaultMode ?? ui.WorkspaceMode.CHECKOUT}
          disabled={!data || resource.busy}
          options={[
            { value: ui.WorkspaceMode.CHECKOUT, label: "Current checkout" },
            { value: ui.WorkspaceMode.NEW_WORKTREE, label: "New worktree" },
          ]}
          onChange={update}
          accessory={
            <ResetSetting
              label="Restore inherited workspace"
              changed={!!data?.settings?.defaultMode}
              disabled={resource.busy}
              onReset={() => update(ui.WorkspaceMode.UNSPECIFIED)}
            />
          }
        />
      </SettingsGroup>
    </ResourceState>
  );
}
