import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { assignedWorkers } from "@canopy/domain/environment-library";
import { Button, Notice } from "../../ui/components";
import { Checkbox } from "../../ui/Checkbox";
import { SettingsActions, SettingsRow } from "./SettingsGroup";
import { EnvironmentItemStatus } from "./EnvironmentItemStatus";

export function EnvironmentSkillRow({
  skill,
  workers,
  busy,
  selected,
  onToggle,
  onInstall,
  onEdit,
  onRemove,
}: {
  skill: ui.LibrarySkill;
  workers: ui.EnvironmentWorker[];
  busy: boolean;
  selected: boolean;
  onToggle: (on: boolean) => void;
  onInstall: () => void;
  onEdit: (kind: "skill" | "source") => void;
  onRemove: () => void;
}) {
  const available = !assignedWorkers(workers, skill.selector, skill.overrides).length;
  const files = skill.artifact?.files.length ?? 0;

  return (
    <SettingsRow
      title={skill.name}
      description={[
        skill.harnesses.filter(Boolean).join(" · "),
        `Version ${skill.version}`,
        `${files} ${files === 1 ? "file" : "files"}`,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <Checkbox label={`Select ${skill.name}`} disabled={busy} checked={selected} onChange={onToggle} />
      <EnvironmentItemStatus item={skill} workers={workers} kind="skills" />
      <View
        style={{ opacity: available ? 1 : 0 }}
        accessibilityElementsHidden={!available}
        importantForAccessibility={available ? "auto" : "no-hide-descendants"}
      >
        <Button title="Install…" disabled={busy || !available} onPress={onInstall} />
      </View>
      <SettingsActions>
        <Button title="Edit skill" onPress={() => onEdit("skill")} />
        {skill.source && <Button title="Check upstream" onPress={() => onEdit("source")} />}
        <Button title="Remove from library" disabled={busy} onPress={onRemove} />
      </SettingsActions>
      {skill.source?.error && <Notice error>Could not check the source. Check upstream to retry.</Notice>}
    </SettingsRow>
  );
}
