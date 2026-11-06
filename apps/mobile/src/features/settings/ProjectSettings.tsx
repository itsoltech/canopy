import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { DefaultModels } from "./SettingsModels";
import { PermissionPickerSheet, permissionLabel } from "../threads/permissions";

export function ProjectSettings() {
  const { projects, workers } = useOverview();
  const resource = useSettingsResource("projects", (api) => api.getSettings({}));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ui.Project>();

  return (
    <ResourceState resource={resource}>
      <Button title="Add project" onPress={() => setAdding(true)} />
      {!projects.some((p) => p.kind !== "scratch") && (
        <Notice>No projects yet. Add a directory or clone a repository on a worker.</Notice>
      )}
      {projects
        .filter((p) => p.kind !== "scratch" && !p.archivedAt)
        .map((project) => (
          <SettingsGroup key={project.id} title={project.name}>
            <SettingsInput
              title="Project name"
              value={project.name}
              busy={resource.busy}
              onSave={async (name) =>
                !!(await resource.run((api) => api.renameProject({ projectId: project.id, name })))
              }
            />
            {project.workspaces.map((ws) => (
              <WorkspaceSettings
                key={ws.id}
                workspace={ws}
                workerName={workers.find((w) => w.id === ws.workerId)?.name ?? "Unknown worker"}
              />
            ))}
            <Button secondary title="Add workspace" onPress={() => setEditing(project)} />
            <ProjectDefaults project={project} />
          </SettingsGroup>
        ))}
      <Sheet title="Add project" visible={adding} onClose={() => setAdding(false)}>
        {adding && <AddProject onSaved={() => setAdding(false)} />}
      </Sheet>
      <Sheet title="Add workspace" visible={!!editing} onClose={() => setEditing(undefined)}>
        {editing && <AddWorkspace project={editing} onSaved={() => setEditing(undefined)} />}
      </Sheet>
    </ResourceState>
  );
}

function WorkspaceSettings({ workspace, workerName }: { workspace: ui.Workspace; workerName: string }) {
  const resource = useSettingsResource(`workspace:${workspace.id}`, (api) => api.getSettings({}));

  return (
    <ResourceState resource={resource}>
      <SettingsRow title={workerName} description={workspace.rootPath}>
        <SettingsInput
          title="Label"
          value={workspace.label}
          busy={resource.busy}
          onSave={async (label) =>
            !!(await resource.run((api) => api.updateWorkspace({ workspaceId: workspace.id, label })))
          }
        />
        <SettingsInput
          title="Root path"
          value={workspace.rootPath}
          busy={resource.busy}
          onSave={async (rootPath) =>
            !!(await resource.run((api) => api.updateWorkspace({ workspaceId: workspace.id, rootPath })))
          }
        />
        <Button
          danger
          title="Remove workspace"
          busy={resource.busy}
          onPress={() =>
            confirmAction(
              "Remove workspace",
              "New threads cannot use this workspace. Existing threads and files stay.",
              () => void resource.run((api) => api.removeWorkspace({ workspaceId: workspace.id })),
            )
          }
        />
      </SettingsRow>
    </ResourceState>
  );
}

function AddProject({ onSaved }: { onSaved: () => void }) {
  const { workers } = useOverview();
  const resource = useSettingsResource("add-project", (api) => api.getOverview({}));
  const [workerId, setWorker] = useState(workers[0]?.id ?? "");
  const [kind, setKind] = useState("directory");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  return (
    <ResourceState resource={resource}>
      <SettingChoice
        title="Worker"
        value={workerId}
        onChange={setWorker}
        options={workers.map((w) => ({ value: w.id, label: w.name, description: w.online ? "Online" : "Offline" }))}
      />
      <SettingChoice
        title="Source"
        value={kind}
        onChange={setKind}
        options={[
          { value: "directory", label: "Existing directory" },
          { value: "init", label: "New directory" },
          { value: "clone", label: "Git repository" },
        ]}
      />
      {kind === "clone" && (
        <Field
          label="Git URL or GitHub owner/repo"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}
      {kind !== "directory" && <Field label="Directory name" value={name} onChangeText={setName} />}
      {workerId && <DirectoryBrowser workerId={workerId} value={path} onChange={setPath} />}
      <Button
        title="Add project"
        busy={resource.busy}
        disabled={!workerId || !path || (kind !== "directory" && !name.trim())}
        onPress={() =>
          void resource
            .run((api) =>
              api.addProject({
                workerId,
                source:
                  kind === "directory"
                    ? { case: "directoryPath", value: path }
                    : kind === "init"
                      ? { case: "init", value: { parentPath: path, name } }
                      : { case: "clone", value: { parentPath: path, name, url } },
              }),
            )
            .then((r) => {
              if (r) onSaved();
            })
        }
      />
    </ResourceState>
  );
}

function AddWorkspace({ project, onSaved }: { project: ui.Project; onSaved: () => void }) {
  const { workers } = useOverview();
  const resource = useSettingsResource("add-workspace", (api) => api.getSettings({}));
  const [workerId, setWorker] = useState(workers[0]?.id ?? "");
  const [rootPath, setPath] = useState("");
  const [label, setLabel] = useState("");

  return (
    <ResourceState resource={resource}>
      <SettingChoice
        title="Worker"
        value={workerId}
        onChange={setWorker}
        options={workers.map((w) => ({ value: w.id, label: w.name }))}
      />
      <Field label="Label" value={label} onChangeText={setLabel} />
      {workerId && <DirectoryBrowser workerId={workerId} value={rootPath} onChange={setPath} />}
      <Button
        title="Add workspace"
        busy={resource.busy}
        disabled={!workerId || !rootPath.trim()}
        onPress={() =>
          void resource
            .run((api) => api.createWorkspace({ projectId: project.id, workerId, rootPath, label }))
            .then((r) => {
              if (r) onSaved();
            })
        }
      />
    </ResourceState>
  );
}

function ProjectDefaults({ project }: { project: ui.Project }) {
  const settings = useAppearance();
  const resource = useSettingsResource(`project-defaults:${project.id}`, (api) => api.getSettings({}));
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
    <ResourceState resource={resource}>
      <SettingsGroup title="New thread defaults" description="Use account defaults unless this project overrides them.">
        <SettingChoice
          title="Worker"
          value={value.workspaceId}
          onChange={(workspaceId) => save({ workspaceId })}
          options={[
            { value: "", label: "Use my default" },
            ...project.workspaces.map((w) => ({ value: w.id, label: w.label || w.rootPath })),
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
        <DefaultModels value={value} onChange={save} />
        <Button
          secondary
          title={`Permissions: ${permissionLabel(value.permissionMode || settings.user?.threadDefaults?.permissionMode)}`}
          onPress={() => setPermission(true)}
        />
        <PermissionPickerSheet
          visible={permission}
          onClose={() => setPermission(false)}
          value={value.permissionMode}
          onSelect={(permissionMode) => save({ permissionMode })}
        />
        <Button
          secondary
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
    </ResourceState>
  );
}
