import { useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { assignedWorkers } from "@canopy/domain/environment-library";
import { Button, Sheet } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { EnvironmentSkillInstall } from "./EnvironmentSkillInstall";
import { EnvironmentSkillRow } from "./EnvironmentSkillRow";
import { EnvironmentActionMenu } from "./EnvironmentActionMenu";
import { EnvironmentRow, EnvironmentRows } from "./EnvironmentRows";
import { createSettingsViewState } from "./SettingsScroll";

type AddSkill = "skill" | "source" | "installer";

const useSelectedSkills = createSettingsViewState<string[] | undefined>(undefined);

export function EnvironmentSkills({
  snapshot,
  workers,
  onAdd,
  onEdit,
  onChanged,
}: {
  snapshot: ui.AgentEnvironmentSnapshot;
  workers: ui.EnvironmentWorker[];
  onAdd: (kind: AddSkill) => void;
  onEdit: (skill: ui.LibrarySkill, kind: "skill" | "source") => void;
  onChanged: () => void;
}) {
  const resource = useSettingsResource("GetAgentEnvironment", (api) => api.getAgentEnvironment({}));
  const [selected, setSelected] = useSelectedSkills();
  const [installing, setInstalling] = useState<string[]>([]);
  const skills = snapshot.skills;
  const selecting = selected !== undefined && skills.length > 0;
  const chosen = skills.filter((skill) => selected?.includes(skill.id)).map((skill) => skill.id);

  const remove = (ids: string[]) =>
    confirmAction(
      "Remove from library",
      "This removes the skills from your shared library and their assigned computers.",
      () => {
        void resource
          .run(async (api) => {
            let revision = snapshot.revision;

            for (const id of ids) {
              const result = await api.deleteLibrarySkill({ id, expectedRevision: revision });
              revision = result.revision;
              setSelected((items) => items?.filter((item) => item !== id));
            }

            if (skills.every((skill) => ids.includes(skill.id))) setSelected(undefined);

            return true;
          })
          .then(() => onChanged());
      },
    );

  function closeInstall() {
    setInstalling([]);
    onChanged();
  }

  return (
    <ResourceState resource={resource} gap={4}>
      <SkillToolbar
        skills={skills}
        workers={workers}
        chosen={chosen}
        selecting={selecting}
        busy={resource.busy}
        onSelect={setSelected}
        onInstall={setInstalling}
        onRemove={remove}
        onAdd={onAdd}
      />
      <EnvironmentRows>
        {!skills.length && (
          <EnvironmentRow
            title="No skills yet"
            description="Import from a website, Git repository, folder or ZIP file."
            wrapDescription
          />
        )}
        {skills.map((skill) => (
          <EnvironmentSkillRow
            key={skill.id}
            skill={skill}
            workers={workers}
            busy={resource.busy}
            checked={selecting ? chosen.includes(skill.id) : undefined}
            onToggle={() =>
              setSelected((items) =>
                items?.includes(skill.id) ? items.filter((id) => id !== skill.id) : [...(items ?? []), skill.id],
              )
            }
            onInstall={() => setInstalling([skill.id])}
            onEdit={(kind) => onEdit(skill, kind)}
            onRemove={() => remove([skill.id])}
          />
        ))}
      </EnvironmentRows>
      <Sheet title="Install skills" visible={!!installing.length} onClose={closeInstall}>
        {!!installing.length && <EnvironmentSkillInstall ids={installing} snapshot={snapshot} onSaved={closeInstall} />}
      </Sheet>
    </ResourceState>
  );
}

function SkillToolbar({
  skills,
  workers,
  chosen,
  selecting,
  busy,
  onSelect,
  onInstall,
  onRemove,
  onAdd,
}: {
  skills: ui.LibrarySkill[];
  workers: ui.EnvironmentWorker[];
  chosen: string[];
  selecting: boolean;
  busy: boolean;
  onSelect: (ids: string[] | undefined) => void;
  onInstall: (ids: string[]) => void;
  onRemove: (ids: string[]) => void;
  onAdd: (kind: AddSkill) => void;
}) {
  const c = useColors("settings");
  const type = useTypography();
  const allSelected = chosen.length === skills.length;
  const unassigned = skills.filter((skill) => !assignedWorkers(workers, skill.selector, skill.overrides).length);

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      {skills.length > 0 ? (
        <Text accessibilityLiveRegion="polite" style={[type.meta, { color: c.muted, flexGrow: 1 }]}>
          {selecting ? `${chosen.length} selected` : `${skills.length} ${skills.length === 1 ? "skill" : "skills"}`}
        </Text>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      {selecting ? (
        <>
          <Button
            title={allSelected ? "Clear all" : "Select all"}
            variant="text"
            size="sm"
            disabled={busy}
            onPress={() => onSelect(allSelected ? [] : skills.map((skill) => skill.id))}
          />
          <EnvironmentActionMenu
            title="Selected skills"
            label="Actions for selected skills"
            buttonTitle="Actions"
            disabled={!chosen.length || busy}
            actions={[
              { label: "Install on…", icon: "arrow-down-tray", onPress: () => onInstall(chosen) },
              { label: "Remove from library", icon: "trash", tone: "danger", onPress: () => onRemove(chosen) },
            ]}
          />
          <Button title="Done" variant="text" size="sm" onPress={() => onSelect(undefined)} />
        </>
      ) : (
        <>
          {!!skills.length && (
            <Button title="Select" label="Select skills" variant="text" size="sm" onPress={() => onSelect([])} />
          )}
          {!!unassigned.length && (
            <EnvironmentActionMenu
              title="Skill library actions"
              label="Skill library actions"
              actions={[
                {
                  label: "Install unassigned skills",
                  icon: "arrow-down-tray",
                  description: `${unassigned.length} ${unassigned.length === 1 ? "skill" : "skills"}`,
                  onPress: () => onInstall(unassigned.map((skill) => skill.id)),
                },
              ]}
            />
          )}
          <EnvironmentActionMenu
            title="Add skills"
            label="Add skills"
            buttonTitle="Add"
            icon="plus"
            actions={[
              { label: "Create skill", icon: "pencil-square", onPress: () => onAdd("skill") },
              { label: "Import skill", icon: "arrow-down-tray", onPress: () => onAdd("source") },
              { label: "Run custom installer", icon: "command-line", onPress: () => onAdd("installer") },
            ]}
          />
        </>
      )}
    </View>
  );
}
