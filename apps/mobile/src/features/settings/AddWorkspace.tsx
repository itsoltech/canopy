import { useState } from "react";
import { ScrollView } from "react-native";
import { ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { workspaceDirectoryName, workspaceParent } from "@canopy/domain/workspace-sources";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { useWorkerPresence } from "../computers/presence";
import { useWorkerOptions } from "../computers/worker-options";
import { useWorkspaceSource } from "./workspace-source";
import { WorkspaceCloneFields } from "./WorkspaceCloneFields";
import { WorkspaceCopy } from "./WorkspaceCopy";
import { WorkspaceSourceChoice } from "./WorkspaceSourceChoice";

interface AddWorkspaceProps {
  project: ui.Project;
  onSaved: () => void;
  onBusy: (busy: boolean) => void;
}

/** All sources share the same project and destination worker. */
export function AddWorkspace({ project, onSaved, onBusy }: AddWorkspaceProps) {
  const { workers, projects } = useOverview();
  const { client } = useSession();
  const presence = useWorkerPresence();
  const workerOptions = useWorkerOptions();
  const [workerId, setWorkerId] = useState("");
  const [source, setSource] = useState("directory");
  const [path, setPath] = useState("");
  const [name, setName] = useState(workspaceDirectoryName(project.workspaces[0]?.rootPath || project.name));
  const { url, setUrl } = useWorkspaceSource(project);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const worker = workers.find((w) => w.id === workerId);
  const available = presence(worker).online && !project.workspaces.some((w) => w.workerId === workerId);
  const copySource = project.workspaces.find((w) => source === `copy:${w.id}`);

  async function add() {
    if (!client || busy || !available) return;
    setBusy(true);
    onBusy(true);
    setError("");

    try {
      await client.api.addProject(
        {
          projectId: project.id,
          workerId,
          source:
            source === "directory"
              ? { case: "directoryPath", value: path }
              : { case: "clone", value: { parentPath: path, name, url } },
        },
        { timeoutMs: 6 * 60_000 + 15_000 },
      );
      onBusy(false);
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof ConnectError
          ? cause.rawMessage
          : "Could not add the workspace. Check the connection and retry.",
      );
    } finally {
      setBusy(false);
      onBusy(false);
    }
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
          setError("");
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
            setSource={setSource}
            busy={busy}
          />
          {source === "clone" && (
            <WorkspaceCloneFields worker={worker} url={url} name={name} busy={busy} setUrl={setUrl} setName={setName} />
          )}
          {!busy && <DirectoryBrowser key={workerId} workerId={workerId} value={path} onChange={setPath} />}
        </>
      )}
      {busy && (
        <Notice>
          {source === "clone" ? `Cloning on ${worker?.name}… This stops after 5 minutes.` : "Adding workspace…"}
        </Notice>
      )}
      {!!error && <Notice error>{error}</Notice>}
      <Button
        variant="primary"
        title={source === "clone" ? "Clone workspace" : "Add workspace"}
        busy={busy}
        disabled={
          !available || !path || (source === "clone" && (!worker?.projectSources || !name.trim() || !url.trim()))
        }
        onPress={() => void add()}
      />
    </ScrollView>
  );
}
