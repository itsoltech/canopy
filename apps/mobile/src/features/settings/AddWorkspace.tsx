import { useState } from "react";
import { ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { workspaceDirectoryName, workspaceParent } from "@canopy/domain/workspace-sources";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { useWorkerLabel, useWorkerPresence } from "../computers/presence";
import { useWorkspaceSource } from "./workspace-source";
import { WorkspaceCloneFields } from "./WorkspaceCloneFields";

/** Existing directory and clone share a destination. A later copy source can join this source choice. */
export function AddWorkspace({
  project,
  onSaved,
  onBusy,
}: {
  project: ui.Project;
  onSaved: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const { workers, projects } = useOverview();
  const { client } = useSession();
  const presence = useWorkerPresence();
  const workerName = useWorkerLabel();
  const [workerId, setWorkerId] = useState("");
  const [source, setSource] = useState("directory");
  const [path, setPath] = useState("");
  const [name, setName] = useState(workspaceDirectoryName(project.workspaces[0]?.rootPath || project.name));
  const { url, setUrl } = useWorkspaceSource(project);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const worker = workers.find((w) => w.id === workerId);
  const available = presence(worker).online && !project.workspaces.some((w) => w.workerId === workerId);

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

  return (
    <>
      <SettingChoice
        title="Worker"
        value={workerId}
        onChange={(id) => {
          setWorkerId(id);
          const next = workers.find((w) => w.id === id);
          setPath(next ? workspaceParent(next, projects) : "");
          setError("");
        }}
        options={workers
          .filter((w) => !w.revokedAt)
          .map((w) => {
            const existing = project.workspaces.some((ws) => ws.workerId === w.id);

            return {
              value: w.id,
              label: workerName(w.id),
              disabled: busy || existing || !presence(w).online,
              description: existing ? "Already added" : (presence(w).reason ?? presence(w).status),
            };
          })}
      />
      {worker && (
        <>
          <SettingChoice
            title="Source"
            value={source}
            onChange={setSource}
            options={[
              { value: "directory", label: "Existing directory", disabled: busy },
              {
                value: "clone",
                label: "Clone repository",
                disabled: busy || !worker.projectSources,
                description: worker.projectSources ? undefined : "Update Canopy on this worker to clone.",
              },
            ]}
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
    </>
  );
}
