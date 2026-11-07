import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { SettingsTextInput } from "./SettingsTextInput";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { DefaultModels } from "./SettingsModels";
import { DefaultResets } from "./DefaultResets";
import { SelectField } from "../../ui/Picker";
import { PermissionPickerSheet, permissionLabel } from "../threads/permissions";
import { SkeletonScope } from "../../ui/Skeleton";
import { SettingsSkeletonGroups } from "./SettingsSkeleton";
import { useWorkerPresence } from "../computers/presence";
import { projectAwayReason } from "@canopy/domain/linked-snapshot";
import { splitId } from "@canopy/domain/computers";

type ProjectResource = ReturnType<typeof useSettingsResource<ui.GetSettingsResponse>>;

export function ProjectSettings() {
  const { projects, workers, computers, loaded } = useOverview();
  const resource = useSettingsResource("projects", (api) => api.getSettings({}));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ui.Project>();

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
          <SettingsGroup key={project.id} title={project.name}>
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
            {project.workspaces.map((ws) => (
              <WorkspaceSettings
                key={ws.id}
                workspace={ws}
                resource={resource}
                workerName={workers.find((w) => w.id === ws.workerId)?.name ?? "Unknown worker"}
              />
            ))}
            {!project.nodeId && (
              <>
                <Button title="Add workspace" onPress={() => setEditing(project)} />
                <ProjectDefaults project={project} resource={resource} />
              </>
            )}
          </SettingsGroup>
        ))}
      <Sheet title="Add project" visible={adding} onClose={() => setAdding(false)}>
        {adding && <AddProject resource={resource} onSaved={() => setAdding(false)} />}
      </Sheet>
      <Sheet title="Add workspace" visible={!!editing} onClose={() => setEditing(undefined)}>
        {editing && <AddWorkspace project={editing} resource={resource} onSaved={() => setEditing(undefined)} />}
      </Sheet>
    </ResourceState>
  );
}

function WorkspaceSettings({
  workspace,
  workerName,
  resource,
}: {
  workspace: ui.Workspace;
  workerName: string;
  resource: ProjectResource;
}) {
  if (splitId(workspace.workerId).node)
    return <SettingsRow title={workerName} description={`${workspace.label || workspace.rootPath} · Read-only`} />;

  return (
    <SettingsRow title={workerName} description={workspace.rootPath}>
      <SettingsTextInput
        title="Label"
        value={workspace.label}
        busy={resource.busy}
        onSave={async (label) =>
          !!(await resource.run((api) => api.updateWorkspace({ workspaceId: workspace.id, label })))
        }
      />
      <SettingsTextInput
        title="Root path"
        value={workspace.rootPath}
        busy={resource.busy}
        onSave={async (rootPath) =>
          !!(await resource.run((api) => api.updateWorkspace({ workspaceId: workspace.id, rootPath })))
        }
      />
      <Button
        variant="danger"
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
  );
}

function AddProject({ onSaved, resource }: { onSaved: () => void; resource: ProjectResource }) {
  const { workers } = useOverview();
  const presence = useWorkerPresence();
  const [workerId, setWorker] = useState(workers[0]?.id ?? "");
  const [kind, setKind] = useState("directory");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const worker = workers.find((w) => w.id === workerId);

  const repository = url
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "");

  const cloneUrl =
    kind === "github" && /^[\w.-]+\/[\w.-]+$/.test(repository) ? `https://github.com/${repository}.git` : url.trim();

  return (
    <ResourceState resource={resource}>
      <SettingChoice
        title="Worker"
        value={workerId}
        onChange={setWorker}
        options={workers.map((w) => ({
          value: w.id,
          label: w.name,
          description: presence(w).reason ?? presence(w).status,
          disabled: !presence(w).online,
        }))}
      />
      <SettingChoice
        title="Source"
        value={kind}
        onChange={setKind}
        options={[
          { value: "directory", label: "Existing directory" },
          { value: "init", label: "New project", disabled: !worker?.projectSources },
          { value: "clone", label: "Git URL", disabled: !worker?.projectSources },
          { value: "github", label: "GitHub repository", disabled: !worker?.projectSources },
        ]}
      />
      {(kind === "clone" || kind === "github") && (
        <>
          <Field
            label={kind === "github" ? "GitHub repository" : "Git URL"}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Notice>
            {worker?.name || "This computer"} clones with its own Git sign-in. Private repositories need access there.
          </Notice>
        </>
      )}
      {kind !== "directory" && <Field label="Directory name" value={name} onChangeText={setName} />}
      {workerId && presence(worker).online && <DirectoryBrowser workerId={workerId} value={path} onChange={setPath} />}
      <Button
        variant="primary"
        title="Add project"
        busy={resource.busy}
        disabled={
          !workerId ||
          !presence(worker).online ||
          !path ||
          (kind !== "directory" && (!name.trim() || !worker?.projectSources)) ||
          (kind === "github" && !/^[\w.-]+\/[\w.-]+$/.test(repository)) ||
          (kind === "clone" && !/^(?:[\w.-]+@[\w.-]+:\S+|(?:https?|ssh|git|file):\/\/\S+)$/i.test(cloneUrl))
        }
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
                      : { case: "clone", value: { parentPath: path, name, url: cloneUrl } },
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

function AddWorkspace({
  project,
  onSaved,
  resource,
}: {
  project: ui.Project;
  onSaved: () => void;
  resource: ProjectResource;
}) {
  const { workers } = useOverview();
  const presence = useWorkerPresence();
  const [workerId, setWorker] = useState(workers[0]?.id ?? "");
  const [rootPath, setPath] = useState("");
  const [label, setLabel] = useState("");
  const worker = workers.find((row) => row.id === workerId);
  const available = Boolean(worker && !worker.nodeId && presence(worker).online);

  return (
    <ResourceState resource={resource}>
      <SettingChoice
        title="Worker"
        value={workerId}
        onChange={setWorker}
        options={workers.map((w) => ({
          value: w.id,
          label: w.name,
          disabled: Boolean(w.nodeId) || !presence(w).online,
          description: presence(w).reason ?? (w.nodeId ? "Add workspaces on their own computer." : undefined),
          badge: presence(w).online ? undefined : presence(w).status,
        }))}
      />
      <Field label="Label" value={label} onChangeText={setLabel} />
      {available && <DirectoryBrowser workerId={workerId} value={rootPath} onChange={setPath} />}
      <Button
        variant="primary"
        title="Add workspace"
        busy={resource.busy}
        disabled={!available || !rootPath.trim()}
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

function ProjectDefaults({ project, resource }: { project: ui.Project; resource: ProjectResource }) {
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
