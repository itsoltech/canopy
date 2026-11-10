import type { ui } from "@canopy/contracts";
import { PickerSheet } from "../../ui/Picker";
import { useWorkerOptions } from "../computers/worker-options";

/**
 * One flat list across computers. Workspace IDs retain the selected worker's home.
 */
export function WorkerPickerSheet({
  visible,
  onClose,
  project,
  workers,
  value,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  project: ui.Project | undefined;
  workers: ui.Worker[];
  value: string | undefined;
  onSelect: (workspaceId: string) => void;
}) {
  const options = useWorkerOptions();

  const rows = options(
    workers.filter(
      (worker) => project?.kind === "scratch" || project?.workspaces.some((w) => w.workerId === worker.id),
    ),
  ).map((option) => {
    const workspace =
      project?.workspaces.find((w) => w.workerId === option.value && w.id === value) ??
      project?.workspaces.find((w) => w.workerId === option.value);

    return {
      ...option,
      value: workspace?.id ?? option.value,
      description: !workspace ? "No scratch directory. Configure this worker." : option.description,
      disabled: !workspace || option.disabled,
    };
  });

  return (
    <PickerSheet
      title="Worker"
      visible={visible}
      onClose={onClose}
      search={rows.length > 6 ? "Search workers" : undefined}
      value={value}
      onSelect={onSelect}
      note={
        rows.length
          ? undefined
          : project?.kind === "scratch"
            ? "Connect a worker first."
            : "This project is not on any worker yet."
      }
      sections={[{ options: rows }]}
    />
  );
}
