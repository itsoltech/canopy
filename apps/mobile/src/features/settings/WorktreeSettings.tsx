import { useState, type ReactNode } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { Button, Notice } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingsRowScope, SettingChoice, SettingToggle } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { ResetSetting } from "./ResetSetting";
import { SettingsSkeletonRows } from "./SettingsSkeleton";

export function WorktreeSettings() {
  const { projects, workers } = useOverview();
  const [projectId, setProject] = useState("");
  const [workerId, setWorker] = useState("");
  const scope = { projectId, workerId };

  const resource = useSettingsResource(`worktree-settings:${projectId}:${workerId}`, (api) =>
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
        options={[{ value: "", label: "All computers" }, ...workers.map((w) => ({ value: w.id, label: w.name }))]}
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
    description: "Remove worktrees after all their threads are deleted.",
  },
  {
    field: "cleanupMerged",
    title: "Merged branches",
    description: "Remove worktrees whose changes reached the base branch.",
  },
  {
    field: "cleanupSettled",
    title: "Settled threads",
    description: "Remove worktrees after all their threads finish or are archived.",
  },
  {
    field: "cleanupUnchanged",
    title: "Unchanged worktrees",
    description: "Remove worktrees with no commits or local changes.",
  },
  {
    field: "deleteLocalBranch",
    title: "Delete safe local branches",
    description: "Also delete branches when their commits are preserved elsewhere.",
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
        description="Local edits always require a separate confirmation before removal."
        soon
      />
    </SettingsGroup>
  );
}

function WorktreeList({ scope }: { scope: { projectId: string; workerId: string } }) {
  const resource = useSettingsResource(`worktrees:${scope.projectId}:${scope.workerId}`, (api) =>
    api.listWorktrees(scope),
  );

  const [preview, setPreview] = useState<ui.ListWorktreesResponse>();

  const remove = (entry: ui.WorktreeEntry) => {
    const id = entry.worktree?.id;

    if (!id) return;
    confirmAction(
      "Remove worktree",
      entry.confirmationRequired
        ? "This deletes local changes in the reviewed worktree. Thread history stays."
        : "This removes the worktree directory. Thread history stays.",
      () =>
        void resource.run((api) =>
          api.removeWorktree({
            worktreeId: id,
            confirmLocalChanges: entry.confirmationRequired,
            expectedHeadCommit: entry.status?.headCommit ?? "",
          }),
        ),
    );
  };

  return (
    <ResourceState resource={resource}>
      <SettingsGroup title="Worktrees">
        <SettingsSkeletonRows controls />
        <Button
          title="Refresh status"
          busy={resource.busy}
          onPress={() => {
            setPreview(undefined);
            void resource.reload();
          }}
        />
        <Button
          title="Preview cleanup"
          busy={resource.busy}
          onPress={() =>
            void resource
              .run((api) => api.cleanupWorktrees({ ...scope, dryRun: true }))
              .then((r) => {
                if (r) setPreview(r);
              })
          }
        />
        {preview && (
          <>
            <Notice>{preview.entries.filter((e) => e.wouldRemove).length} worktrees qualify for cleanup.</Notice>
            <Button
              variant="danger"
              title="Clean up worktrees"
              disabled={!preview.entries.some((e) => e.wouldRemove)}
              busy={resource.busy}
              onPress={() =>
                confirmAction(
                  "Clean up worktrees",
                  "Canopy checks the policy again and removes safe worktrees. Local changes stay.",
                  () =>
                    void resource
                      .run((api) => api.cleanupWorktrees({ ...scope, dryRun: false }))
                      .then(() => setPreview(undefined)),
                )
              }
            />
          </>
        )}
        {(preview ?? resource.data)?.entries.map((entry) => (
          <SettingsRow
            key={entry.worktree?.id}
            title={entry.worktree?.branch || "Worktree"}
            description={entry.worktree?.path}
          >
            <SettingsValue
              title="Status"
              value={
                entry.detail ||
                entry.status?.detail ||
                (entry.removed ? "Removed" : entry.busy ? "Busy" : entry.online ? "Online" : "Offline")
              }
            />
            <SettingsValue
              title="Changes"
              value={`${entry.status?.dirtyFiles ?? 0} files · ${entry.status?.ahead ?? 0} ahead · ${entry.status?.behind ?? 0} behind${entry.status?.unpushed ? " · Unpushed commits" : ""}`}
            />
            <Button
              variant="danger"
              title="Remove worktree"
              disabled={resource.busy || !entry.online || entry.busy || entry.removed || !entry.status?.headCommit}
              onPress={() => remove(entry)}
            />
          </SettingsRow>
        ))}
        {resource.data && !resource.data.entries.length && (
          <SettingsRow title="No worktrees yet" description="Start a thread in a new worktree to add one." />
        )}
      </SettingsGroup>
    </ResourceState>
  );
}
