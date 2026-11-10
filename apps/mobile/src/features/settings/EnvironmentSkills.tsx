import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { Button, Sheet } from "../../ui/components";
import { Checkbox } from "../../ui/Checkbox";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { EnvironmentSkillInstall } from "./EnvironmentSkillInstall";
import { EnvironmentSkillRow } from "./EnvironmentSkillRow";

export function EnvironmentSkills({
  snapshot,
  workers,
  onAdd,
  onEdit,
  onChanged,
}: {
  snapshot: ui.AgentEnvironmentSnapshot;
  workers: ui.EnvironmentWorker[];
  onAdd: (kind: "skill" | "source") => void;
  onEdit: (skill: ui.LibrarySkill, kind: "skill" | "source") => void;
  onChanged: () => void;
}) {
  const resource = useSettingsResource("GetAgentEnvironment", (api) => api.getAgentEnvironment({}));
  const [selected, setSelected] = useState<string[]>([]);
  const [installing, setInstalling] = useState<string[]>([]);
  const chosen = snapshot.skills.filter((s) => selected.includes(s.id));

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
              setSelected((items) => items.filter((item) => item !== id));
            }

            return true;
          })
          .then(() => onChanged());
      },
    );

  return (
    <ResourceState resource={resource}>
      <SettingsGroup title="Skills" actions={<Button title="Add skill" onPress={() => onAdd("skill")} />}>
        <Button title="Add from Git" onPress={() => onAdd("source")} />
        {!!snapshot.skills.length && (
          <>
            <Checkbox
              label={`Select all skills (${chosen.length} selected)`}
              disabled={resource.busy}
              checked={chosen.length === snapshot.skills.length}
              onChange={(on) => setSelected(on ? snapshot.skills.map((s) => s.id) : [])}
            />
            <SettingsActions>
              <Button
                title="Install on…"
                disabled={!chosen.length || resource.busy}
                onPress={() => setInstalling(chosen.map((s) => s.id))}
              />
              <Button
                title="Remove from library"
                disabled={!chosen.length || resource.busy}
                onPress={() => remove(chosen.map((s) => s.id))}
              />
            </SettingsActions>
          </>
        )}
        {!snapshot.skills.length && (
          <SettingsRow title="No skills yet" description="Add a skill folder, ZIP or Git source." />
        )}
        {snapshot.skills.map((skill) => (
          <EnvironmentSkillRow
            key={skill.id}
            skill={skill}
            workers={workers}
            busy={resource.busy}
            selected={selected.includes(skill.id)}
            onToggle={(on) => setSelected(on ? [...selected, skill.id] : selected.filter((id) => id !== skill.id))}
            onInstall={() => setInstalling([skill.id])}
            onEdit={(kind) => onEdit(skill, kind)}
            onRemove={() => remove([skill.id])}
          />
        ))}
      </SettingsGroup>
      <Sheet
        title="Install skills"
        visible={!!installing.length}
        onClose={() => {
          setInstalling([]);
          onChanged();
        }}
      >
        {!!installing.length && (
          <EnvironmentSkillInstall
            ids={installing}
            snapshot={snapshot}
            onSaved={() => {
              setInstalling([]);
              onChanged();
            }}
          />
        )}
      </Sheet>
    </ResourceState>
  );
}
