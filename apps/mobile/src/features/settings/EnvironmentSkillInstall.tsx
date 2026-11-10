import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Button, Notice } from "../../ui/components";
import { EnvironmentAssignment } from "./EnvironmentAssignment";
import { ResourceState, useSettingsResource } from "./resource";

export function EnvironmentSkillInstall({
  ids,
  snapshot,
  onSaved,
}: {
  ids: string[];
  snapshot: ui.AgentEnvironmentSnapshot;
  onSaved: () => void;
}) {
  const resource = useSettingsResource("GetAgentEnvironment", (api) => api.getAgentEnvironment({}));
  const [selector, setSelector] = useState(create(ui.EnvironmentSelectorSchema, { everyone: true }));
  const [revision, setRevision] = useState(snapshot.revision);
  const [openedRevision] = useState(snapshot.revision);
  const [remaining, setRemaining] = useState(ids);
  const stale = snapshot.revision !== openedRevision && snapshot.revision !== revision;

  const install = () =>
    void resource
      .run(async (api) => {
        let current = revision;

        for (const id of remaining) {
          const skill = snapshot.skills.find((s) => s.id === id);

          if (!skill) throw new Error("Skill no longer exists");

          const saved = await api.saveLibrarySkill({
            skill: { ...skill, artifact: undefined, selector },
            expectedRevision: current,
          });

          current = saved.revision;
          setRevision(current);
          setRemaining((items) => items.filter((item) => item !== id));
        }

        return true;
      })
      .then((saved) => {
        if (saved) onSaved();
      });

  return (
    <ResourceState resource={resource}>
      <Notice>
        Assign these skills to all computers, specific computers or tags. Existing computer overrides stay in place.
      </Notice>
      <EnvironmentAssignment value={selector} workers={snapshot.workers} onChange={setSelector} />
      {remaining.length < ids.length && (
        <Notice>
          {ids.length - remaining.length} of {ids.length} saved. Retry to install the remaining skills.
        </Notice>
      )}
      {stale && <Notice>The library changed. Close and reopen this picker before installing.</Notice>}
      <Button title="Install" variant="primary" busy={resource.busy} disabled={stale} onPress={install} />
    </ResourceState>
  );
}
