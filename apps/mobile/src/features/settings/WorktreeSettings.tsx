import type { ReactNode } from "react";
import { useLocalSearchParams, useRoute } from "expo-router";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { Button } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingsRowScope, SettingChoice, SettingToggle } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { ResourceState, useSettingsResource } from "./resource";
import { ResetSetting } from "./ResetSetting";
import { RecordedWorktreeSettings } from "./RecordedWorktreeSettings";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { ConfigNoticesFor } from "./ConfigNoticesFor";
import { splitId } from "@canopy/domain/computers";
import { useWorkerRecordOptions } from "../computers/worker-options";
import { SettingsTopics } from "./SettingsTopics";
import { WorktreeList } from "./WorktreeList";

import { createSettingsViewState } from "./SettingsScroll";

type Scope = { projectId: string; workerId: string; worktreeId?: string };

const useWorktreeScope = createSettingsViewState<Scope>({ projectId: "", workerId: "" });

function useSelectedScope() {
  const initial = useLocalSearchParams<{ projectId?: string; workerId?: string; worktreeId?: string }>();
  const route = useRoute();
  const entry = initial.projectId || initial.workerId || initial.worktreeId ? route.key : undefined;

  return useWorktreeScope(entry, {
    projectId: initial.projectId ?? "",
    workerId: initial.workerId ?? "",
    worktreeId: initial.worktreeId,
  });
}

export function WorktreeSettings() {
  const { projects } = useOverview();
  const records = useSettingsResource("ListWorkerRecords", (api) => api.listWorkerRecords({}));
  const workerOptions = useWorkerRecordOptions(records.data?.records ?? []);
  const [{ projectId, workerId, worktreeId: focused }, setScope] = useSelectedScope();
  const scope = { projectId, workerId };

  const remote = !!splitId(workerId).node;
  const record = records.data?.records.find((entry) => entry.workerId === workerId);

  const readOnly =
    remote && records.data
      ? (record?.readOnlyReason ?? "Manage this worker on its own computer. Configuration is not shared.")
      : "";

  const canRead = !remote || (!!records.data && !readOnly);

  const resource = useSettingsResource(
    `GetWorktreeSettings:${projectId}:${workerId}`,
    (api) => api.getWorktreeSettings(scope),
    canRead,
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
        <Button title="Show all worktree settings" onPress={() => setScope(scope)} />
        {remote ? (
          <SettingsRow
            title="Worktree management"
            description="Manage this worktree on the computer where it was created."
          />
        ) : (
          <WorktreeList scope={scope} worktreeId={focused} />
        )}
      </>
    );

  return (
    <>
      <SettingsGroup>
        <SettingChoice
          title="Project"
          value={projectId}
          onChange={(projectId) => setScope({ ...scope, projectId })}
          disabled={resource.busy}
          options={[
            { value: "", label: "All projects" },
            ...projects.filter((p) => !p.nodeId && p.kind !== "scratch").map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        <SettingChoice
          title="Computer"
          value={workerId}
          onChange={(workerId) => setScope({ ...scope, workerId })}
          disabled={resource.busy}
          options={[{ value: "", label: "All computers" }, ...workerOptions]}
        />
        {canRead && response && !resource.initialLoading && (
          <Button
            title="Restore inherited settings"
            disabled={resource.busy}
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
        )}
      </SettingsGroup>
      {remote && !records.data && (
        <ResourceState resource={records}>
          {!records.error && <SettingsRow title="Loading worker settings…" />}
        </ResourceState>
      )}
      {readOnly ? (
        <RecordedWorktreeSettings
          reason={readOnly}
          settings={record?.worktreeSettings.find((policy) => policy.projectId === projectId)?.settings}
        />
      ) : null}
      {canRead && (
        <ResourceState resource={resource}>
          {!workerId && (
            <ConfigNoticesFor
              match={(notice) => notice.kind === "worktree_policy" && notice.localId === (projectId || "account")}
              onChanged={resource.reload}
            />
          )}
          {response && (
            <WorktreeTopics
              key={`${projectId}:${workerId}`}
              scope={scope}
              response={response}
              busy={resource.busy}
              save={save}
            />
          )}
        </ResourceState>
      )}
    </>
  );
}

type Fields = {
  response: ui.WorktreeSettingsResponse;
  busy: boolean;
  save: (patch: Partial<ui.WorktreeSettings>) => Promise<boolean>;
};

function WorktreeTopics({ scope, ...fields }: Fields & { scope: Scope }) {
  return (
    <SettingsTopics
      topics={[
        { id: "creation", label: "New worktrees", content: <WorktreeCreation {...fields} /> },
        { id: "cleanup", label: "Cleanup rules", content: <WorktreeCleanup {...fields} /> },
        {
          id: "worktrees",
          label: "Manage worktrees",
          hidden: !!splitId(scope.workerId).node,
          content: <WorktreeList scope={scope} />,
        },
      ]}
    />
  );
}

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
            title="Worktree location"
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
        <SettingsDisclosure viewKey={`advanced:${response.projectId}:${response.workerId}`} title="Advanced">
          <WorktreeField response={response} field="remote" onReset={() => void save({ remote: undefined })}>
            <SettingsInput
              title="Remote"
              description="Used when the base branch has no upstream."
              value={v.remote ?? "origin"}
              busy={busy}
              onSave={(remote) => save({ remote: remote || undefined })}
            />
          </WorktreeField>
        </SettingsDisclosure>
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
              { value: ui.BranchNaming.TITLE, label: "Thread title", description: "Soon", disabled: true },
            ]}
          />
        </WorktreeField>
        <WorktreeField response={response} field="branchPrefix" onReset={() => void save({ branchPrefix: undefined })}>
          <SettingsInput
            title="Branch prefix"
            value={v.branchPrefix ?? "canopy"}
            busy={busy}
            onSave={(branchPrefix) => save({ branchPrefix: branchPrefix || undefined })}
          />
        </WorktreeField>
      </SettingsGroup>
      <SettingsGroup title="New threads">
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
          title="Inactive for days"
          description="0 disables cleanup by age."
          value={String(v.cleanupInactiveDays ?? 0)}
          busy={busy}
          keyboardType="number-pad"
          onSave={(text) => save({ cleanupInactiveDays: Math.min(3650, Math.max(0, Math.trunc(Number(text) || 0))) })}
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
