import { useState, type ReactNode } from "react";
import { View } from "react-native";
import type { SkillArtifact, ui } from "@canopy/contracts";
import { libraryWorkers } from "@canopy/domain/environment-library";
import { Button, Notice, Sheet } from "../../ui/components";
import { ContentInsets, useContentInsets } from "../../ui/ScreenFrame";
import { SettingsTopicPicker } from "./SettingsTopics";
import { SettingsScroll, createSettingsViewState } from "./SettingsScroll";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { InstructionEditor } from "./InstructionEditor";
import { SkillEditor } from "./SkillEditor";
import { SkillInstaller } from "./SkillInstaller";
import { SkillSourceEditor } from "./SkillSourceEditor";
import { MarketplaceSettings } from "./MarketplaceSettings";
import { EnvironmentComputers } from "./EnvironmentComputers";
import { SettingsSkeletonRows } from "./SettingsSkeleton";
import { EnvironmentSkills } from "./EnvironmentSkills";
import { EnvironmentInstructions } from "./EnvironmentInstructions";
import { SharedConfiguration } from "./SharedConfiguration";

type Editor = {
  kind: "instruction" | "source" | "skill" | "installer";
  snapshot: ui.AgentEnvironmentSnapshot;
  id?: string;
  collected?: SkillArtifact;
  installerWorkerId?: string;
};

const panels = [
  { id: "instructions", label: "Instructions" },
  { id: "skills", label: "Skills" },
  { id: "plugins", label: "Plugins" },
  { id: "computers", label: "Computers" },
] as const;

type Panel = (typeof panels)[number]["id"];

const usePanel = createSettingsViewState<Panel>("instructions");
const useSelectedWorker = createSettingsViewState("");

export function AgentEnvironmentSettings({ position, notices }: { position: string; notices: ReactNode }) {
  const insets = useContentInsets();
  const [panel, setPanel] = usePanel(position);

  return (
    <View style={{ flex: 1, minWidth: 0, paddingTop: insets.top }}>
      <View style={{ paddingLeft: insets.left + 12, paddingRight: insets.right + 12, paddingTop: 8 }}>
        <SettingsTopicPicker options={panels} value={panel} onChange={setPanel} />
      </View>
      <ContentInsets.Provider value={{ ...insets, top: 0 }}>
        <SettingsScroll
          key={panel}
          position={`${position}:${panel}`}
          space={12}
          keyboardShouldPersistTaps="handled"
          style={{ flex: 1, minWidth: 0 }}
          contentContainerStyle={{ maxWidth: 1024, gap: 12 }}
        >
          {notices}
          <EnvironmentPanel panel={panel} />
        </SettingsScroll>
      </ContentInsets.Provider>
    </View>
  );
}

function EnvironmentPanel({ panel }: { panel: Panel }) {
  const resource = useSettingsResource("GetAgentEnvironment", (api) => api.getAgentEnvironment({}));
  const [editor, setEditor] = useState<Editor>();
  const [workerId, setWorker] = useSelectedWorker();
  const snapshot = resource.data;
  const records = useSettingsResource("ListWorkerRecords", (api) => api.listWorkerRecords({}));
  const computers = useSettingsResource("GetComputers", (api) => api.getComputers({}));
  const workers = libraryWorkers(snapshot?.workers ?? [], records.data?.records ?? []);

  const removeDocument = (id: string) =>
    confirmAction(
      "Delete document",
      "This removes the document from its assigned computers. Local text outside Canopy’s block stays.",
      () =>
        void resource.run((api) => api.deleteInstructionDocument({ id, expectedRevision: snapshot?.revision ?? 0n })),
    );

  const reload = () => void resource.reload().catch(() => {});

  const saved = () => {
    setEditor((current) => (current === editor ? undefined : current));
    reload();
  };

  const edit = (kind: Editor["kind"], id?: string) => {
    if (snapshot) setEditor({ kind, id, snapshot });
  };

  return (
    <ResourceState resource={resource} gap={12}>
      {resource.initialLoading && <SettingsSkeletonRows rows={4} />}
      {snapshot && (
        <>
          <SharedConfiguration
            library
            notices={(computers.data?.configNotices ?? []).filter((n) =>
              ["instruction", "skill", "marketplace", "plugin"].includes(n.kind),
            )}
            onChanged={() => {
              void computers.reload().catch(() => {});
              reload();
            }}
          />
          {panel === "instructions" && (
            <EnvironmentInstructions
              documents={snapshot.documents}
              workers={workers}
              busy={resource.busy}
              onAdd={() => edit("instruction")}
              onEdit={(id) => edit("instruction", id)}
              onDelete={removeDocument}
            />
          )}
          {panel === "skills" && (
            <EnvironmentSkills
              snapshot={snapshot}
              workers={workers}
              onAdd={edit}
              onEdit={(item, kind) => edit(kind, item.id)}
              onChanged={reload}
            />
          )}
          {panel === "plugins" && <MarketplaceSettings snapshot={snapshot} workers={workers} onChanged={reload} />}
          {panel === "computers" && (
            <EnvironmentComputers
              snapshot={snapshot}
              records={records.data?.records ?? []}
              busy={resource.loading || resource.busy}
              workerId={workerId}
              setWorker={setWorker}
              onChanged={reload}
            />
          )}
          <Sheet
            title={
              editor?.kind === "instruction"
                ? editor.id
                  ? "Edit instruction document"
                  : "Add instruction document"
                : editor?.kind === "source"
                  ? "Skill source"
                  : editor?.kind === "installer"
                    ? "Run custom installer"
                    : "Skill"
            }
            visible={!!editor}
            onClose={() => setEditor(undefined)}
          >
            {editor?.kind === "installer" ? (
              <SkillInstaller
                workers={snapshot.workers}
                onCollect={(collected, installerWorkerId) =>
                  setEditor((current) =>
                    current === editor ? { kind: "skill", snapshot, collected, installerWorkerId } : current,
                  )
                }
                onImport={() => edit("skill")}
                onRefresh={reload}
              />
            ) : (
              editor && (
                <LibraryEditor
                  key={editor.snapshot.revision.toString()}
                  editor={editor}
                  latest={snapshot}
                  onSaved={saved}
                  onReload={() => {
                    const items = editor.kind === "instruction" ? snapshot.documents : snapshot.skills;

                    if (editor.id && !items.some((item) => item.id === editor.id)) setEditor(undefined);
                    else setEditor({ ...editor, snapshot });
                  }}
                />
              )
            )}
          </Sheet>
        </>
      )}
    </ResourceState>
  );
}

function LibraryEditor({
  editor,
  latest,
  onSaved,
  onReload,
}: {
  editor: Editor;
  latest: ui.AgentEnvironmentSnapshot;
  onSaved: () => void;
  onReload: () => void;
}) {
  const { snapshot, kind, id } = editor;
  const skill = snapshot.skills.find((item) => item.id === id);
  const document = snapshot.documents.find((item) => item.id === id);
  const conflict = snapshot.revision !== latest.revision;

  return (
    <>
      {kind !== "source" && conflict && (
        <>
          <Notice>The environment changed while you were editing. Copy any unsaved text before reloading.</Notice>
          <Button title="Discard draft and reload" onPress={onReload} />
        </>
      )}
      {kind === "instruction" && (
        <InstructionEditor document={document} snapshot={snapshot} conflict={conflict} onSaved={onSaved} />
      )}
      {kind === "skill" && (
        <SkillEditor
          skill={skill}
          collected={editor.collected}
          installerWorkerId={editor.installerWorkerId}
          snapshot={snapshot}
          conflict={conflict}
          onSaved={onSaved}
        />
      )}
      {kind === "source" && <SkillSourceEditor skill={skill} snapshot={latest} onSaved={onSaved} />}
    </>
  );
}
