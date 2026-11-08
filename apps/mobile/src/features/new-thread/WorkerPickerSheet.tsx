import type { ui } from "@canopy/contracts";
import { PickerSheet, type PickerSection } from "../../ui/Picker";
import { useWorkerPresence } from "../computers/presence";

/**
 * The project's workspaces by worker, grouped by computer as on the web: this computer first, then linked ones by
 * name. A worker on a linked computer this one cannot reach is greyed out with the reason.
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
  const presence = useWorkerPresence();
  const groups = new Map<string, PickerSection<string>>();

  const rows = workers
    .map((worker) => ({
      worker,
      workspace:
        project?.workspaces.find((workspace) => workspace.workerId === worker.id && workspace.id === value) ??
        project?.workspaces.find((workspace) => workspace.workerId === worker.id),
    }))
    .filter((row) => project?.kind === "scratch" || row.workspace)
    .map((row) => ({ ...row, presence: presence(row.worker) }))
    .sort(
      (a, b) =>
        Number(Boolean(a.worker?.nodeId)) - Number(Boolean(b.worker?.nodeId)) ||
        a.presence.computer.localeCompare(b.presence.computer) ||
        (a.worker?.name ?? "").localeCompare(b.worker?.name ?? ""),
    );

  for (const { workspace, worker, presence: p } of rows) {
    const home = worker?.nodeId ?? "";
    const group = groups.get(home) ?? { id: home, title: p.computer, options: [] };

    group.options.push({
      value: workspace?.id ?? worker.id,
      label: worker?.name ?? "Unknown worker",
      description: !workspace
        ? "No scratch directory. Configure this worker."
        : (p.reason ?? (project?.kind === "scratch" ? "Scratch folder" : workspace.label || workspace.rootPath)),
      icon: "computer-desktop",
      badge: p.online ? undefined : p.status,
      tone: p.online || p.away ? undefined : "warning",
      disabled: !workspace || p.away,
      keywords: p.computer,
    });
    groups.set(home, group);
  }

  const sections = [...groups.values()];

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
      // Computer headings only once there is more than one computer.
      sections={sections.length > 1 ? sections : sections.map((s) => ({ id: s.id, options: s.options }))}
    />
  );
}
