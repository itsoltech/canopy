import { Fragment, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Button, Field, Notice } from "../../ui/components";
import { SettingToggle } from "./SettingsGroup";
import { useSourcePreview } from "./source-preview";
import { ResourceState } from "./resource";
import { EnvironmentDestinations } from "./EnvironmentAssignment";
import { EnvironmentFiles } from "./EnvironmentFiles";

export function SkillSourceEditor({
  snapshot,
  skill,
  onSaved,
}: {
  snapshot: ui.AgentEnvironmentSnapshot;
  skill?: ui.LibrarySkill;
  onSaved: () => void;
}) {
  const { resource, request, fields, preview, setPreview } = useSourcePreview<ui.SkillSourcePreview>("skill", skill);
  const [revision, setRevision] = useState(snapshot.revision);
  const [paths, setPaths] = useState<string[]>([]);

  const [assignment, setAssignment] = useState(() =>
    create(
      ui.LibrarySkillSchema,
      skill ?? { platformHome: true, harnesses: ["claude", "codex", "grok"], selector: { everyone: true } },
    ),
  );

  return (
    <ResourceState resource={resource}>
      {fields}
      <Button
        title={skill ? "Check upstream" : "Preview source"}
        busy={resource.busy}
        onPress={() =>
          void resource
            .run(async (api) => {
              const result = skill
                ? await api.checkSkillSource({ id: skill.id })
                : await api.previewSkillSource(request);

              const current = await api.getAgentEnvironment({});

              return { result, revision: current.revision };
            })
            .then((r) => {
              if (r) {
                setPreview(r.result);
                setRevision(r.revision);
                setPaths(r.result.skills.map((s) => s.path));

                if (!skill)
                  setAssignment(
                    create(ui.LibrarySkillSchema, {
                      ...assignment,
                      harnesses: r.result.harnesses,
                      deviceHome: r.result.deviceHome,
                    }),
                  );
              }
            })
        }
      />
      {preview && (
        <>
          <Notice>
            {preview.source?.url} · {preview.source?.ref} · {preview.source?.commit}
          </Notice>
          {preview.notices.map((note, index) => (
            <Notice key={index}>{note}</Notice>
          ))}
          {preview.skills.map((item) => (
            <Fragment key={item.path}>
              <SettingToggle
                title={item.artifact?.name || item.path}
                value={paths.includes(item.path)}
                onChange={(on) => setPaths(on ? [...paths, item.path] : paths.filter((p) => p !== item.path))}
              />
              <EnvironmentFiles artifact={item.artifact} before={skill?.artifact} />
            </Fragment>
          ))}
          <Field
            label="Library name"
            value={assignment.name}
            onChangeText={(name) => setAssignment(create(ui.LibrarySkillSchema, { ...assignment, name }))}
          />
          <EnvironmentDestinations value={assignment} workers={snapshot.workers} onChange={setAssignment} />
          <Button
            variant="primary"
            title={skill ? "Apply reviewed update" : "Add and sync"}
            disabled={!paths.length}
            busy={resource.busy}
            onPress={() =>
              void resource
                .run((api) =>
                  skill
                    ? api.applySkillSource({ id: skill.id, previewId: preview.id, expectedRevision: revision })
                    : api.addSkillSource({
                        previewId: preview.id,
                        paths,
                        assignment,
                        expectedRevision: revision,
                      }),
                )
                .then((r) => {
                  if (r) onSaved();
                })
            }
          />
        </>
      )}
    </ResourceState>
  );
}
