import type { ui } from "@canopy/contracts";
import { useWorkerLabel, useWorkerPresence } from "../computers/presence";
import { SettingChoice } from "./SettingsGroup";

export function WorkspaceSourceChoice({
  worker,
  workers,
  project,
  source,
  setSource,
  busy,
}: {
  worker: ui.Worker;
  workers: ui.Worker[];
  project: ui.Project;
  source: string;
  setSource: (source: string) => void;
  busy: boolean;
}) {
  const presence = useWorkerPresence();
  const workerName = useWorkerLabel();

  return (
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
        ...project.workspaces.map((workspace) => {
          const from = workers.find((w) => w.id === workspace.workerId);

          return {
            value: `copy:${workspace.id}`,
            label: `Copy from ${workerName(workspace.workerId)}`,
            disabled: busy || !worker.workspaceCopy || !from?.workspaceCopy || !presence(from).online,
            description:
              !worker.workspaceCopy || !from?.workspaceCopy
                ? "Update this worker to copy files"
                : presence(from).reason,
          };
        }),
      ]}
    />
  );
}
