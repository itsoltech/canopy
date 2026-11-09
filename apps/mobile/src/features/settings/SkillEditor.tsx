import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ui, type SkillFile } from "@canopy/contracts";
import * as DocumentPicker from "expo-document-picker";
import { Directory, File } from "expo-file-system";
import { Button, Field, Notice } from "../../ui/components";
import { SettingChoice, SettingToggle } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { EnvironmentDestinations } from "./EnvironmentAssignment";
import { SkillFileReview } from "./SkillFileReview";
import { EnvironmentWizard } from "./EnvironmentWizard";

export function SkillEditor({
  skill,
  snapshot,
  onSaved,
}: {
  skill?: ui.LibrarySkill;
  snapshot: ui.AgentEnvironmentSnapshot;
  onSaved: () => void;
}) {
  const resource = useSettingsResource("GetAgentEnvironment", (api) => api.getAgentEnvironment({}));
  const [selectedVersion, setSelectedVersion] = useState(skill?.version ?? 0n);

  const versionPreview = useSettingsResource(
    `GetAgentEnvironment:skill:${skill?.id ?? "new"}:${selectedVersion}`,
    (api) => api.getAgentEnvironment(skill ? { previewSkillId: skill.id, previewSkillVersion: selectedVersion } : {}),
  );

  const [draft, setDraft] = useState(() =>
    create(
      ui.LibrarySkillSchema,
      skill ?? { platformHome: true, harnesses: ["claude", "codex", "grok"], selector: { everyone: true } },
    ),
  );

  const [files, setFiles] = useState<SkillFile[]>([]);
  const [zip, setZip] = useState<Uint8Array>();
  const [error, setError] = useState("");
  const change = (patch: Partial<ui.LibrarySkill>) => setDraft(create(ui.LibrarySkillSchema, { ...draft, ...patch }));

  async function upload(folder: boolean) {
    setError("");

    try {
      if (folder) {
        const directory = await Directory.pickDirectoryAsync();
        const result = await readSkillDirectory(directory);
        setFiles(result);
        setZip(undefined);
      } else {
        const result = await DocumentPicker.getDocumentAsync({
          type: ["application/zip", "application/x-zip-compressed"],
          copyToCacheDirectory: true,
        });

        if (result.canceled) return;
        const file = new File(result.assets[0]!.uri);

        if (file.size > 10 * 1024 ** 2) throw new Error("Archive too large");
        setZip(new Uint8Array(await file.arrayBuffer()));
        setFiles([]);
      }
    } catch {
      setError("Could not read this skill. Choose a folder with SKILL.md or a ZIP under 10 MiB, then retry.");
    }
  }

  return (
    <ResourceState resource={resource}>
      <EnvironmentWizard
        steps={["Files & version", "Review files", "Assign & confirm"]}
        busy={resource.busy}
        disabled={
          !draft.name.trim() ||
          (!skill && !files.length && !zip?.length) ||
          Boolean(skill && !files.length && !zip && !versionPreview.data?.previewSkillArtifact)
        }
        onSave={() =>
          void resource
            .run((api) =>
              api.saveLibrarySkill({ skill: draft, files, ...(zip && { zip }), expectedRevision: snapshot.revision }),
            )
            .then((r) => {
              if (r) onSaved();
            })
        }
      >
        {(step) =>
          step === 0 ? (
            <>
              <Field label="Library name" value={draft.name} onChangeText={(name) => change({ name })} />
              <Button title="Choose folder" onPress={() => void upload(true)} />
              <Button title="Choose ZIP" onPress={() => void upload(false)} />
              {skill && (
                <SettingChoice
                  title="Library version"
                  value={String(draft.version)}
                  options={skill.versions.map((v) => ({ value: String(v), label: `Version ${v}` }))}
                  onChange={(v) => {
                    const version = BigInt(v);
                    change({ version });
                    setSelectedVersion(version);
                    setFiles([]);
                    setZip(undefined);
                  }}
                />
              )}
              {draft.source && <SkillSourcePolicy source={draft.source} onChange={(source) => change({ source })} />}
              {error ? <Notice error>{error}</Notice> : null}
            </>
          ) : step === 1 ? (
            <SkillFileReview files={files} zip={zip} draft={draft} before={skill?.artifact} preview={versionPreview} />
          ) : (
            <EnvironmentDestinations value={draft} workers={snapshot.workers} onChange={setDraft} />
          )
        }
      </EnvironmentWizard>
    </ResourceState>
  );
}

function SkillSourcePolicy({ source, onChange }: { source: ui.SkillSource; onChange: (v: ui.SkillSource) => void }) {
  return (
    <>
      <Notice>Uploading new files detaches upstream tracking. Rolling back pins the selected version.</Notice>
      <SettingToggle
        title="Automatically update this skill"
        description="Check hourly. Script or executable changes always need review."
        value={source.autoUpdate}
        onChange={(autoUpdate) => onChange(create(ui.SkillSourceSchema, { ...source, autoUpdate }))}
      />
      <SettingToggle
        title="Pin this version"
        value={source.pinned}
        onChange={(pinned) => onChange(create(ui.SkillSourceSchema, { ...source, pinned }))}
      />
    </>
  );
}

async function readSkillDirectory(root: Directory): Promise<SkillFile[]> {
  const result: SkillFile[] = [];
  let total = 0;

  async function visit(directory: Directory, prefix: string) {
    for (const entry of directory.list()) {
      if (result.length >= 1000) throw new Error("Too many files");
      const path = `${prefix}${entry.name}`;

      if (entry instanceof Directory) await visit(entry, `${path}/`);
      else {
        total += entry.size;

        if (entry.size > 1024 ** 2 || total > 25 * 1024 ** 2) throw new Error("Skill too large");
        result.push({
          $typeName: "canopy.worker.v1.SkillFile",
          path,
          content: new Uint8Array(await entry.arrayBuffer()),
          checksum: "",
          executable: false,
        });
      }
    }
  }

  await visit(root, "");

  return result;
}
