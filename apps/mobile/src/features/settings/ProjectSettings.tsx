import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { Button, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { SettingsTextInput } from "./SettingsTextInput";
import { ResourceState, useSettingsResource } from "./resource";
import { DefaultModels } from "./SettingsModels";
import { DefaultResets } from "./DefaultResets";
import { SelectField } from "../../ui/Picker";
import { PermissionPickerSheet, permissionLabel } from "../threads/permissions";
import { SkeletonScope } from "../../ui/Skeleton";
import { SettingsSkeletonGroups } from "./SettingsSkeleton";
import { useWorkerOptions } from "../computers/worker-options";
import { useProjectDetails } from "../computers/project-details";
import { projectAwayReason } from "@canopy/domain/linked-snapshot";
import { AddWorkspace } from "./AddWorkspace";
import { WorkspaceRow } from "./WorkspaceRow";
import { AddProject } from "./AddProject";

type ProjectResource = ReturnType<typeof useSettingsResource<ui.GetSettingsResponse>>;

export function ProjectSettings() {
  const { projects: records, projectChoices: projects, workers, computers, loaded } = useOverview();
  const details = useProjectDetails();
  const resource = useSettingsResource("GetSettings", (api) => api.getSettings({}));
  const [adding, setAdding] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [editing, setEditing] = useState<ui.Project>();
  const [addingWorkspace, setAddingWorkspace] = useState(false);

  return (
    <ResourceState resource={resource}>
      <Button variant="primary" title="Add project" onPress={() => setAdding(true)} />
      {!loaded && (
        <SkeletonScope loading>
          <SettingsSkeletonGroups titles={[" "]} />
        </SkeletonScope>
      )}
      {loaded && !projects.some((p) => p.kind !== "scratch" && !p.archivedAt) && (
        <SettingsGroup>
          <SettingsRow
            title="No projects yet"
            description="A project groups threads. Its workspaces are directories on your workers."
          />
        </SettingsGroup>
      )}
      {projects
        .filter((p) => p.kind !== "scratch" && !p.archivedAt)
        .map((project) => (
          <SettingsGroup key={project.id} title={project.name} description={details.places(project)}>
            {project.nodeId ? (
              <SettingsRow
                title={project.name}
                description={
                  projectAwayReason(project, workers, computers) ??
                  "This project is on a linked computer. Manage it there."
                }
              />
            ) : (
              <>
                <SettingsTextInput
                  title="Project name"
                  value={project.name}
                  busy={resource.busy}
                  onSave={async (name) =>
                    !!(await resource.run((api) => api.renameProject({ projectId: project.id, name })))
                  }
                />
              </>
            )}
            <SettingsGroup title="Workspaces">
              {project.workspaces.map((ws) => (
                <WorkspaceRow key={ws.id} workspace={ws} />
              ))}
              <Button title="Add workspace" onPress={() => setEditing(project)} />
            </SettingsGroup>
            {!project.nodeId && (
              <>
                <ProjectDefaults
                  project={records.find((record) => record.id === project.id) ?? project}
                  resource={resource}
                />
              </>
            )}
          </SettingsGroup>
        ))}
      <Sheet title="Add project" visible={adding} onClose={() => !addingProject && setAdding(false)}>
        {adding && <AddProject onBusy={setAddingProject} onSaved={() => setAdding(false)} />}
      </Sheet>
      <Sheet
        title="Add workspace"
        visible={!!editing}
        scroll={false}
        onClose={() => !addingWorkspace && setEditing(undefined)}
      >
        {editing && (
          <AddWorkspace project={editing} onBusy={setAddingWorkspace} onSaved={() => setEditing(undefined)} />
        )}
      </Sheet>
    </ResourceState>
  );
}

function ProjectDefaults({ project, resource }: { project: ui.Project; resource: ProjectResource }) {
  const { workers } = useOverview();
  const workerOptions = useWorkerOptions();
  const settings = useAppearance();
  const [permission, setPermission] = useState(false);
  const row = resource.data?.projects.find((p) => p.projectId === project.id);
  const value = create(ui.ThreadDefaultsSchema, row?.threadDefaults);

  const save = (patch: Partial<ui.ThreadDefaults>) =>
    void resource.run((api) =>
      api.updateProjectSettings({
        projectId: project.id,
        threadDefaults: create(ui.ThreadDefaultsSchema, { ...value, ...patch }),
        expectedVersion: row?.version ?? 0n,
      }),
    );

  return (
    <DefaultResets value={value} onChange={save} inherited disabled={resource.busy}>
      <SettingsGroup title="New thread defaults" description="Use account defaults unless this project overrides them.">
        <SettingChoice
          title="Worker"
          value={value.workspaceId}
          onChange={(workspaceId) => save({ workspaceId })}
          options={[
            { value: "", label: "Use my default" },
            ...workerOptions(
              workers.filter((worker) => project.workspaces.some((w) => w.workerId === worker.id)),
              false,
            ).flatMap((option) =>
              project.workspaces.filter((w) => w.workerId === option.value).map((w) => ({ ...option, value: w.id })),
            ),
          ]}
        />
        <SettingChoice
          title="Agent"
          value={value.provider}
          onChange={(provider) => save({ provider, providerProfileId: "" })}
          options={[
            { value: Provider.UNSPECIFIED, label: "Use my default" },
            { value: Provider.CLAUDE, label: "Claude" },
            { value: Provider.CODEX, label: "Codex" },
            { value: Provider.GROK, label: "Grok" },
          ]}
        />
        {!!value.provider && <DefaultModels value={value} onChange={save} />}
        <SettingsRow
          title="Permissions"
          description="New threads of this project use this approval policy."
          control={
            <SelectField
              label="Permissions"
              hideLabel
              value={
                value.permissionMode
                  ? permissionLabel(value.permissionMode)
                  : `Use my default (${permissionLabel(settings.user?.threadDefaults?.permissionMode)})`
              }
              onPress={() => setPermission(true)}
            />
          }
        />
        <PermissionPickerSheet
          visible={permission}
          onClose={() => setPermission(false)}
          value={value.permissionMode}
          onSelect={(permissionMode) => save({ permissionMode })}
        />
        <Button
          title="Restore account defaults"
          onPress={() =>
            void resource.run((api) =>
              api.updateProjectSettings({
                projectId: project.id,
                threadDefaults: create(ui.ThreadDefaultsSchema),
                expectedVersion: row?.version ?? 0n,
              }),
            )
          }
        />
      </SettingsGroup>
    </DefaultResets>
  );
}
