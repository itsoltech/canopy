import type { ui } from "@canopy/contracts";
import { useWorkerPresence } from "../computers/presence";
import { useWorkerOptions } from "../computers/worker-options";
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
  const options = useWorkerOptions()(workers, false);

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
          const option = options.find((o) => o.value === workspace.workerId);

          return {
            value: `copy:${workspace.id}`,
            label: `Copy from ${option?.label ?? "Unknown worker"}`,
            suffix: option?.suffix,
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
