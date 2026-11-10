import { useState } from "react";
import { ScrollView } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { workspaceDirectoryName, workspaceParent } from "@canopy/domain/workspace-sources";
import { useOverview } from "../../state/overview";
import { Button, Notice } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { useWorkerPresence } from "../computers/presence";
import { useWorkerOptions } from "../computers/worker-options";
import { useWorkspaceSource } from "./workspace-source";
import { WorkspaceCloneFields } from "./WorkspaceCloneFields";
import { WorkspaceCopy } from "./WorkspaceCopy";
import { WorkspaceSourceChoice } from "./WorkspaceSourceChoice";
import { useAddProject } from "./use-add-project";
import { CloneProgress } from "./CloneProgress";

interface AddWorkspaceProps {
  project: ui.Project;
  onSaved: () => void;
  onBusy: (busy: boolean) => void;
}

/** All sources share the same project and destination worker. */
export function AddWorkspace({ project, onSaved, onBusy }: AddWorkspaceProps) {
  const { workers, projects } = useOverview();
  const presence = useWorkerPresence();
  const workerOptions = useWorkerOptions();
  const [workerId, setWorkerId] = useState("");
  const [source, setSource] = useState("directory");
  const [path, setPath] = useState("");
  const [name, setName] = useState(workspaceDirectoryName(project.workspaces[0]?.rootPath || project.name));
  const { url, setUrl } = useWorkspaceSource(project);
  const action = useAddProject(onSaved, onBusy);
  const { busy, error } = action;
  const worker = workers.find((w) => w.id === workerId);
  const available = presence(worker).online && !project.workspaces.some((w) => w.workerId === workerId);
  const copySource = project.workspaces.find((w) => source === `copy:${w.id}`);

  async function add() {
    if (busy || !available) return;
    await action.add(
      create(ui.AddProjectRequestSchema, {
        projectId: project.id,
        workerId,
        source:
          source === "directory"
            ? { case: "directoryPath", value: path }
            : { case: "clone", value: { parentPath: path, name, url } },
      }),
      worker?.cloneProgress ?? false,
    );
  }

  if (worker && copySource)
    return (
      <WorkspaceCopy
        project={project}
        worker={worker}
        workspace={copySource}
        initialParent={path}
        initialName={name}
        onBusy={onBusy}
        onSaved={onSaved}
        onBack={() => setSource("directory")}
      />
    );

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      contentContainerStyle={{ padding: 20, gap: 16, width: "100%", maxWidth: 600, alignSelf: "center" }}
    >
      <SettingChoice
        title="Worker"
        value={workerId}
        onChange={(id) => {
          setWorkerId(id);
          const next = workers.find((w) => w.id === id);
          setPath(next ? workspaceParent(next, projects) : "");
          action.reset();
        }}
        options={workerOptions(workers.filter((w) => !w.revokedAt)).map((option) => {
          const existing = project.workspaces.some((ws) => ws.workerId === option.value);

          return {
            ...option,
            disabled: busy || existing || option.disabled,
            description: existing ? "Already added" : option.description,
          };
        })}
      />
      {worker && (
        <>
          <WorkspaceSourceChoice
            worker={worker}
            workers={workers}
            project={project}
            source={source}
            setSource={(value) => {
              setSource(value);
              action.reset();
            }}
            busy={busy}
          />
          {source === "clone" && (
            <WorkspaceCloneFields worker={worker} url={url} name={name} busy={busy} setUrl={setUrl} setName={setName} />
          )}
          {!busy && <DirectoryBrowser key={workerId} workerId={workerId} value={path} onChange={setPath} />}
        </>
      )}
      {source === "clone" && action.attempted && (
        <CloneProgress
          capable={worker?.cloneProgress ?? false}
          progress={action.progress}
          busy={busy}
          failed={!!error}
          onCancel={worker?.cloneProgress ? action.cancel : undefined}
        />
      )}
      {busy && source !== "clone" && <Notice>Adding workspace…</Notice>}
      {!!error && <Notice error>{error}</Notice>}
      <Button
        variant="primary"
        title={error ? "Retry" : source === "clone" ? "Clone workspace" : "Add workspace"}
        busy={busy}
        disabled={
          !available || !path || (source === "clone" && (!worker?.projectSources || !name.trim() || !url.trim()))
        }
        onPress={() => void add()}
      />
    </ScrollView>
  );
}
