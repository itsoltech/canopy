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

  const rows = (project?.workspaces ?? [])
    .map((workspace) => ({ workspace, worker: workers.find((w) => w.id === workspace.workerId) }))
    .map((row) => ({ ...row, presence: presence(row.worker) }))
    .sort(
      (a, b) =>
        Number(Boolean(a.worker?.nodeId)) - Number(Boolean(b.worker?.nodeId)) ||
        a.presence.computer.localeCompare(b.presence.computer) ||
        (a.worker?.name ?? "").localeCompare(b.worker?.name ?? ""),
    );

  for (const { workspace, worker, presence: p } of rows) {
    const group = groups.get(p.computer) ?? { title: p.computer, options: [] };

    group.options.push({
      value: workspace.id,
      label: worker?.name ?? "Unknown worker",
      description: p.reason ?? (project?.kind === "scratch" ? "Scratch folder" : workspace.label || workspace.rootPath),
      icon: "computer-desktop",
      badge: p.online ? undefined : p.status,
      tone: p.online || p.away ? undefined : "warning",
      disabled: p.away,
      keywords: p.computer,
    });
    groups.set(p.computer, group);
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
      note={project?.workspaces.length ? undefined : "This project is not on any worker yet."}
      // Computer headings only once there is more than one computer.
      sections={sections.length > 1 ? sections : sections.map((s) => ({ options: s.options }))}
    />
  );
}
