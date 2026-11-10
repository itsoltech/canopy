import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { Button, Sheet } from "../../ui/components";
import { SettingsActions, SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { InstructionEditor } from "./InstructionEditor";
import { SkillEditor } from "./SkillEditor";
import { SkillSourceEditor } from "./SkillSourceEditor";
import { MarketplaceSettings } from "./MarketplaceSettings";
import { EnvironmentComputer } from "./EnvironmentComputer";
import { SettingsSkeletonGroups } from "./SettingsSkeleton";
import { libraryWorkers } from "@canopy/domain/environment-library";
import { EnvironmentLibrarySummary } from "./EnvironmentLibrarySummary";
import { EnvironmentSkills } from "./EnvironmentSkills";
import { EnvironmentItemStatus } from "./EnvironmentItemStatus";
import { SharedConfiguration } from "./SharedConfiguration";

export function AgentEnvironmentSettings() {
  const resource = useSettingsResource("GetAgentEnvironment", (api) => api.getAgentEnvironment({}));
  const [editor, setEditor] = useState<"instruction" | "skill" | "source">();
  const [document, setDocument] = useState<ui.InstructionDocument>();
  const [skill, setSkill] = useState<ui.LibrarySkill>();
  const [workerId, setWorker] = useState("");
  const snapshot = resource.data;
  const records = useSettingsResource("ListWorkerRecords", (api) => api.listWorkerRecords({}));
  const computers = useSettingsResource("GetComputers", (api) => api.getComputers({}));
  const workers = libraryWorkers(snapshot?.workers ?? [], records.data?.records ?? []);

  const removeDocument = (id: string) =>
    confirmAction(
      "Delete instructions",
      "This removes the document from its assigned computers. Local text outside Canopy’s block stays.",
      () =>
        void resource.run((api) => api.deleteInstructionDocument({ id, expectedRevision: snapshot?.revision ?? 0n })),
    );

  const saved = () => {
    setEditor(undefined);
    void resource.reload();
  };

  const add = (kind: "instruction" | "skill" | "source") => {
    setDocument(undefined);
    setSkill(undefined);
    setEditor(kind);
  };

  return (
    <ResourceState resource={resource}>
      <Button title="Refresh status" busy={resource.busy} onPress={() => void resource.reload()} />
      {resource.initialLoading && (
        <SettingsSkeletonGroups titles={["Instructions", "Skills", "Marketplaces", "Computers"]} />
      )}
      {snapshot && (
        <>
          <EnvironmentLibrarySummary snapshot={snapshot} workers={workers} onChanged={() => void resource.reload()} />
          <SharedConfiguration
            library
            notices={(computers.data?.configNotices ?? []).filter((n) =>
              ["instruction", "skill", "marketplace", "plugin"].includes(n.kind),
            )}
            onChanged={() => {
              void computers.reload();
              void resource.reload();
            }}
          />
          <SettingsGroup
            title="Instructions"
            actions={<Button title="Add instructions" onPress={() => add("instruction")} />}
          >
            {!snapshot.documents.length && (
              <SettingsRow
                title="No instructions yet"
                description="Add a document and assign it to see what agents receive."
              />
            )}
            {snapshot.documents.map((doc) => (
              <InstructionRow
                key={doc.id}
                document={doc}
                workers={workers}
                busy={resource.busy}
                onEdit={() => {
                  setDocument(doc);
                  setEditor("instruction");
                }}
                onDelete={() => removeDocument(doc.id)}
              />
            ))}
          </SettingsGroup>
          <EnvironmentSkills
            snapshot={snapshot}
            workers={workers}
            onAdd={add}
            onEdit={(item, kind) => {
              setSkill(item);
              setEditor(kind);
            }}
            onChanged={() => void resource.reload()}
          />
          <MarketplaceSettings snapshot={snapshot} workers={workers} onChanged={() => void resource.reload()} />
          <EnvironmentComputers
            snapshot={snapshot}
            workerId={workerId}
            setWorker={setWorker}
            onChanged={() => void resource.reload()}
          />
          <Sheet
            title={editor === "instruction" ? "Instructions" : editor === "source" ? "Skill source" : "Skill"}
            visible={!!editor}
            onClose={() => setEditor(undefined)}
          >
            {editor === "instruction" && <InstructionEditor document={document} snapshot={snapshot} onSaved={saved} />}
            {editor === "skill" && <SkillEditor skill={skill} snapshot={snapshot} onSaved={saved} />}
            {editor === "source" && <SkillSourceEditor skill={skill} snapshot={snapshot} onSaved={saved} />}
          </Sheet>
        </>
      )}
    </ResourceState>
  );
}

function InstructionRow({
  document,
  workers,
  busy,
  onEdit,
  onDelete,
}: {
  document: ui.InstructionDocument;
  workers: ui.EnvironmentWorker[];
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <SettingsRow
      title={document.name}
      description={`${document.harness} · ${document.fragments.length} ${document.fragments.length === 1 ? "fragment" : "fragments"} · ${document.selector?.everyone ? "All computers" : "Selected computers and tags"}`}
    >
      <EnvironmentItemStatus item={document} workers={workers} kind="instructions" harness={document.harness} />
      <SettingsActions>
        <Button title="Edit instructions" onPress={onEdit} />
        <Button variant="danger" title="Delete instructions" disabled={busy} onPress={onDelete} />
      </SettingsActions>
    </SettingsRow>
  );
}

function EnvironmentComputers({
  snapshot,
  workerId,
  setWorker,
  onChanged,
}: {
  snapshot: ui.AgentEnvironmentSnapshot;
  workerId: string;
  setWorker: (id: string) => void;
  onChanged: () => void;
}) {
  return (
    <>
      <SettingsGroup title="Computers">
        <SettingChoice
          title="Computer"
          value={workerId}
          onChange={setWorker}
          options={snapshot.workers.map((w) => ({
            value: w.workerId,
            label: w.name,
            description: w.online ? "Online" : "Offline",
          }))}
        />
        {!snapshot.workers.length && (
          <SettingsRow title="No computers yet" description="Add a worker to sync its agent environment." />
        )}
      </SettingsGroup>
      {snapshot.workers.flatMap((w) =>
        w.workerId === workerId
          ? [<EnvironmentComputer key={w.workerId} worker={w} revision={snapshot.revision} onChanged={onChanged} />]
          : [],
      )}
    </>
  );
}
