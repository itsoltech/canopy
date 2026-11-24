import type { ui } from "@canopy/contracts";
import { EnvironmentActionMenu, type EnvironmentAction } from "./EnvironmentActionMenu";
import { EnvironmentRow } from "./EnvironmentRows";
import { environmentItemStatus } from "./environment-item-status";

export function EnvironmentSkillRow({
  skill,
  workers,
  busy,
  checked,
  onToggle,
  onInstall,
  onEdit,
  onRemove,
}: {
  skill: ui.LibrarySkill;
  workers: ui.EnvironmentWorker[];
  busy: boolean;
  checked?: boolean;
  onToggle: () => void;
  onInstall: () => void;
  onEdit: (kind: "skill" | "source") => void;
  onRemove: () => void;
}) {
  const { status, computers, note } = environmentItemStatus(skill, workers, "skills");
  const files = skill.artifact?.files.length ?? 0;

  const description = [`v${skill.version}`, `${files} ${files === 1 ? "file" : "files"}`, computers, ...skill.harnesses]
    .filter(Boolean)
    .join(" · ");

  const actions: EnvironmentAction[] = [{ label: "Edit skill", icon: "pencil-square", onPress: () => onEdit("skill") }];

  if (status === "Not installed") actions.push({ label: "Install…", icon: "arrow-down-tray", onPress: onInstall });

  if (skill.source)
    actions.push({
      label: "Check upstream",
      icon: "arrow-path",
      description: skill.source.error ? "Could not check the source. Try again." : undefined,
      onPress: () => onEdit("source"),
    });

  actions.push({ label: "Remove from library", icon: "trash", tone: "danger", onPress: onRemove });

  return (
    <EnvironmentRow
      title={skill.name}
      description={description}
      status={skill.source?.error ? "Source check failed" : status}
      warning={!!skill.source?.error || status === "Error"}
      checked={checked}
      disabled={checked !== undefined && busy}
      onPress={checked === undefined ? () => onEdit("skill") : onToggle}
      actions={
        <EnvironmentActionMenu
          title={skill.name}
          label={`Actions for ${skill.name}`}
          actions={actions}
          note={`${description}\n${note}`}
          disabled={busy}
        />
      }
    />
  );
}
