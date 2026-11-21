import { useState, type ReactNode } from "react";
import { useLocalSearchParams } from "expo-router";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { Button } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingsRowScope, SettingChoice, SettingToggle } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { ResourceState, useSettingsResource } from "./resource";
import { ResetSetting } from "./ResetSetting";
import { useWorkerOptions } from "../computers/worker-options";
import { WorktreeList } from "./WorktreeList";

export function WorktreeSettings() {
  const initial = useLocalSearchParams<{ projectId?: string; workerId?: string; worktreeId?: string }>();
  const { projects, workers } = useOverview();
  const workerOptions = useWorkerOptions();
  const [projectId, setProject] = useState(initial.projectId ?? "");
  const [workerId, setWorker] = useState(initial.workerId ?? "");
  const [focused, setFocused] = useState(initial.worktreeId);
  const scope = { projectId, workerId };

  const resource = useSettingsResource(`GetWorktreeSettings:${projectId}:${workerId}`, (api) =>
    api.getWorktreeSettings(scope),
  );

  const response = resource.data ?? (resource.initialLoading ? create(ui.WorktreeSettingsResponseSchema) : undefined);

  const save = async (patch: Partial<ui.WorktreeSettings>) =>
    !!(
      response &&
      (await resource.run((api) =>
        api.updateWorktreeSettings({
          ...scope,
          expectedVersion: response.version,
          settings: create(ui.WorktreeSettingsSchema, {
            ...create(ui.WorktreeSettingsSchema, response.settings),
            ...patch,
          }),
        }),
      ))
    );

  if (focused)
    return (
      <>
        <Button title="Show all worktree settings" onPress={() => setFocused(undefined)} />
        <WorktreeList scope={scope} worktreeId={focused} />
      </>
    );

  return (
    <ResourceState resource={resource}>
      <SettingChoice
        title="Project"
        value={projectId}
        onChange={setProject}
        options={[
          { value: "", label: "All projects" },
          ...projects.filter((p) => p.kind !== "scratch").map((p) => ({ value: p.id, label: p.name })),
        ]}
      />
      <SettingChoice
        title="Computer"
        value={workerId}
        onChange={setWorker}
        options={[{ value: "", label: "All computers" }, ...workerOptions(workers, false)]}
      />
      {response && (
        <>
          <WorktreeCreation response={response} busy={resource.busy} save={save} />
          <WorktreeCleanup response={response} busy={resource.busy} save={save} />
          <Button
            title="Restore inherited settings"
            busy={resource.busy}
            onPress={() =>
              void resource.run((api) =>
                api.updateWorktreeSettings({
                  ...scope,
                  expectedVersion: response.version,
                  settings: create(ui.WorktreeSettingsSchema),
                }),
              )
            }
          />
          <WorktreeList key={`${projectId}:${workerId}`} scope={scope} />
        </>
      )}
    </ResourceState>
  );
}

type Fields = {
  response: ui.WorktreeSettingsResponse;
  busy: boolean;
  save: (patch: Partial<ui.WorktreeSettings>) => Promise<boolean>;
};

function WorktreeField({
  response,
  field,
  onReset,
  children,
}: {
  response: ui.WorktreeSettingsResponse;
  field: keyof ui.WorktreeSettings;
  onReset: () => void;
  children: ReactNode;
}) {
  const { projects, workers } = useOverview();
  const value = response.settings?.[field];
  const changed = value !== undefined && (!["branchNaming", "defaultMode"].includes(field) || value !== 0);
  const source = response.inheritedSources.find((s) => s.field === field);

  const from = source
    ? [
        projects.find((p) => p.id === source.projectId)?.name || "All projects",
        workers.find((w) => w.id === source.workerId)?.name || "All computers",
      ].join(" · ")
    : "Canopy default";

  return (
    <SettingsRowScope.Provider
      value={{
        caption: changed ? "Overridden here" : `Inherited: ${from}`,
        accessory: (
          <ResetSetting
            label={`Reset ${field.replace(/[A-Z]/g, " $&").toLowerCase()} to inherited`}
            changed={changed}
            onReset={onReset}
          />
        ),
      }}
    >
      {children}
    </SettingsRowScope.Provider>
  );
}

function WorktreeCreation({ response, busy, save }: Fields) {
  const v = create(ui.WorktreeSettingsSchema, response.effective);

  return (
    <>
      <SettingsGroup title="Creation">
        <WorktreeField response={response} field="location" onReset={() => void save({ location: undefined })}>
          <SettingsInput
            title="Location"
            description="Leave empty to use the worker’s managed worktree directory."
            value={v.location ?? ""}
            busy={busy}
            onSave={(location) => save({ location })}
          />
        </WorktreeField>
        <WorktreeField
          response={response}
          field="startFromRemote"
          onReset={() => void save({ startFromRemote: undefined })}
        >
          <SettingToggle
            title="Start from remote"
            description="Fetch the latest tracked branch before creating a worktree."
            value={v.startFromRemote ?? false}
            disabled={busy}
            onChange={(startFromRemote) => void save({ startFromRemote })}
          />
        </WorktreeField>
        <WorktreeField response={response} field="remote" onReset={() => void save({ remote: undefined })}>
          <SettingsInput
            title="Remote"
            description="Used when the base branch has no upstream."
            value={v.remote ?? "origin"}
            busy={busy}
            onSave={(remote) => save({ remote })}
          />
        </WorktreeField>
        <WorktreeField
          response={response}
          field="defaultMode"
          onReset={() => void save({ defaultMode: ui.WorkspaceMode.UNSPECIFIED })}
        >
          <SettingChoice
            title="Default workspace"
            value={v.defaultMode}
            disabled={busy}
            onChange={(defaultMode) => void save({ defaultMode })}
            options={[
              { value: ui.WorkspaceMode.CHECKOUT, label: "Current checkout" },
              { value: ui.WorkspaceMode.NEW_WORKTREE, label: "New worktree" },
            ]}
          />
        </WorktreeField>
      </SettingsGroup>
      <SettingsGroup title="Branches">
        <WorktreeField
          response={response}
          field="branchNaming"
          onReset={() => void save({ branchNaming: ui.BranchNaming.UNSPECIFIED })}
        >
          <SettingChoice
            title="Branch naming"
            value={v.branchNaming}
            disabled={busy}
            onChange={(branchNaming) => void save({ branchNaming })}
            options={[
              { value: ui.BranchNaming.SEMANTIC, label: "Semantic prefix" },
              { value: ui.BranchNaming.PREFIX, label: "Fixed prefix" },
            ]}
          />
        </WorktreeField>
        <SettingsRow title="Thread title" description="Name branches from the thread title." soon />
        <WorktreeField response={response} field="branchPrefix" onReset={() => void save({ branchPrefix: undefined })}>
          <SettingsInput
            title="Branch prefix"
            value={v.branchPrefix ?? "canopy"}
            busy={busy}
            onSave={(branchPrefix) => save({ branchPrefix })}
          />
        </WorktreeField>
      </SettingsGroup>
    </>
  );
}

const cleanupFields = [
  {
    field: "cleanupDeletedThreads",
    title: "Deleted threads",
    description: "Remove a worktree and discard local files once all its threads are deleted.",
  },
  {
    field: "cleanupMerged",
    title: "Merged branches",
    description: "Remove worktrees whose changes reached the base branch.",
  },
  {
    field: "cleanupSettled",
    title: "Archived threads",
    description: "Remove a worktree and discard local files once all remaining threads are archived.",
  },
  {
    field: "cleanupUnchanged",
    title: "Unchanged worktrees",
    description: "Remove worktrees with no commits or local changes.",
  },
  {
    field: "deleteLocalBranch",
    title: "Delete safe local branches",
    description:
      "After worktree removal, clean up unused, merged feature branches once all their threads are archived.",
  },
] satisfies { field: keyof ui.WorktreeSettings; title: string; description: string }[];

function WorktreeCleanup({ response, busy, save }: Fields) {
  const v = create(ui.WorktreeSettingsSchema, response.effective);

  return (
    <SettingsGroup title="Cleanup">
      {cleanupFields.map(({ field, title, description }) => (
        <WorktreeField key={field} response={response} field={field} onReset={() => void save({ [field]: undefined })}>
          <SettingToggle
            title={title}
            description={description}
            value={Boolean(v[field])}
            disabled={busy}
            onChange={(value) => void save({ [field]: value })}
          />
        </WorktreeField>
      ))}
      <WorktreeField
        response={response}
        field="cleanupInactiveDays"
        onReset={() => void save({ cleanupInactiveDays: undefined })}
      >
        <SettingsInput
          title="Inactive days"
          description="0 disables cleanup by age."
          value={String(v.cleanupInactiveDays ?? 0)}
          busy={busy}
          keyboardType="number-pad"
          onSave={(text) => save({ cleanupInactiveDays: Number(text) })}
        />
      </WorktreeField>
      <SettingsRow
        title="Keep local changes"
        description="Other cleanup rules need your confirmation before discarding local changes."
        soon
      />
    </SettingsGroup>
  );
}
