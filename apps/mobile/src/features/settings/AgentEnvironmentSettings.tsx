import { useState } from "react";
import { createSettingsViewState } from "./SettingsScroll";
import type { ui } from "@canopy/contracts";
import { Button, Notice, Sheet } from "../../ui/components";
import { SettingsActions, SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { InstructionEditor } from "./InstructionEditor";
import { SkillEditor } from "./SkillEditor";
import { SkillSourceEditor } from "./SkillSourceEditor";
import { MarketplaceSettings } from "./MarketplaceSettings";
import { EnvironmentComputer } from "./EnvironmentComputer";
import { LinkedEnvironmentComputer } from "./LinkedEnvironmentComputer";
import { useComputerHome } from "../computers/presence";
import { useWorkerRecordOptions } from "../computers/worker-options";
import { splitId } from "@canopy/domain/computers";
import { SettingsSkeletonGroups } from "./SettingsSkeleton";
import { libraryWorkers } from "@canopy/domain/environment-library";
import { EnvironmentLibrarySummary } from "./EnvironmentLibrarySummary";
import { EnvironmentSkills } from "./EnvironmentSkills";
import { EnvironmentItemStatus } from "./EnvironmentItemStatus";
import { SharedConfiguration } from "./SharedConfiguration";

type Editor = { kind: "instruction" | "source" | "skill"; snapshot: ui.AgentEnvironmentSnapshot; id?: string };

const useSelectedWorker = createSettingsViewState("");

export function AgentEnvironmentSettings() {
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
    <ResourceState resource={resource}>
      {resource.initialLoading && (
        <SettingsSkeletonGroups titles={["Instruction library", "Skills", "Marketplaces", "Computers & preview"]} />
      )}
      {snapshot && (
        <>
          <EnvironmentLibrarySummary snapshot={snapshot} workers={workers} onChanged={reload} />
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
          <SettingsGroup
            title="Instruction library"
            actions={<Button title="Add document" onPress={() => edit("instruction")} />}
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
                onEdit={() => edit("instruction", doc.id)}
                onDelete={() => removeDocument(doc.id)}
              />
            ))}
          </SettingsGroup>
          <EnvironmentSkills
            snapshot={snapshot}
            workers={workers}
            onAdd={edit}
            onEdit={(item, kind) => edit(kind, item.id)}
            onChanged={reload}
          />
          <MarketplaceSettings snapshot={snapshot} workers={workers} onChanged={reload} />
          <EnvironmentComputers
            snapshot={snapshot}
            records={records.data?.records ?? []}
            busy={resource.loading || resource.busy}
            workerId={workerId}
            setWorker={setWorker}
            onChanged={reload}
          />
          <Sheet
            title={
              editor?.kind === "instruction"
                ? editor.id
                  ? "Edit instruction document"
                  : "Add instruction document"
                : editor?.kind === "source"
                  ? "Skill source"
                  : "Skill"
            }
            visible={!!editor}
            onClose={() => setEditor(undefined)}
          >
            {editor && (
              <LibraryEditor
                key={editor.snapshot.revision.toString()}
                editor={editor}
                latest={snapshot}
                onSaved={saved}
                onReload={() => {
                  const items = editor.kind === "instruction" ? snapshot.documents : snapshot.skills;

                  if (editor.id && !items.some((item) => item.id === editor.id)) setEditor(undefined);
                  else edit(editor.kind, editor.id);
                }}
              />
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
      {kind === "skill" && <SkillEditor skill={skill} snapshot={snapshot} conflict={conflict} onSaved={onSaved} />}
      {kind === "source" && <SkillSourceEditor skill={skill} snapshot={latest} onSaved={onSaved} />}
    </>
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
      description={[
        document.harness === "claude" ? "CLAUDE.md" : "AGENTS.md",
        `v${document.revision}`,
        `${document.fragments.length} ${document.fragments.length === 1 ? "fragment" : "fragments"}`,
        document.selector?.everyone ? "All computers" : "Selected computers and tags",
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <EnvironmentItemStatus item={document} workers={workers} kind="instructions" harness={document.harness} />
      <SettingsActions>
        <Button title="Edit document" onPress={onEdit} />
        <Button variant="danger" title="Delete document" disabled={busy} onPress={onDelete} />
      </SettingsActions>
    </SettingsRow>
  );
}

function EnvironmentComputers({
  snapshot,
  records,
  busy,
  workerId,
  setWorker,
  onChanged,
}: {
  snapshot: ui.AgentEnvironmentSnapshot;
  records: ui.WorkerRecord[];
  busy: boolean;
  workerId: string;
  setWorker: (id: string) => void;
  onChanged: () => void;
}) {
  const liveOptions = useWorkerRecordOptions(records.filter((record) => !record.revoked));

  const options = [
    ...liveOptions.filter(
      (option) => !!splitId(option.value).node || snapshot.workers.some((worker) => worker.workerId === option.value),
    ),
    ...snapshot.workers
      .filter((worker) => !liveOptions.some((option) => option.value === worker.workerId))
      .map((worker) => ({
        value: worker.workerId,
        label: worker.name,
        description: worker.online ? "Online" : "Offline",
      })),
  ];

  const selected = workerId || snapshot.workers[0]?.workerId || options[0]?.value || "";
  const unavailable = !!selected && !options.some((option) => option.value === selected);

  const local = snapshot.workers.find((worker) => worker.workerId === selected);
  const node = splitId(selected).node;
  const record = records.find((item) => item.workerId === selected);
  const home = useComputerHome(node);

  const reason =
    record?.readOnlyReason ??
    (node ? home.reason || "Manage this worker on its own computer. Configuration is not shared." : "");

  return (
    <>
      <SettingsGroup
        title="Computers & preview"
        actions={!node && <Button title="Refresh status" busy={busy} onPress={onChanged} />}
      >
        {options.length ? (
          <SettingChoice
            title="Computer"
            value={selected}
            onChange={setWorker}
            options={
              unavailable ? [{ value: selected, label: "Unavailable computer", disabled: true }, ...options] : options
            }
          />
        ) : (
          <SettingsRow title="No computers yet" description="Add a worker to sync its agent environment." />
        )}
      </SettingsGroup>
      {unavailable ? (
        options.length > 0 && (
          <Notice>This computer is unavailable. Choose another computer to manage its environment.</Notice>
        )
      ) : node ? (
        <LinkedEnvironmentComputer key={selected} workerId={selected} reason={reason} />
      ) : (
        local && (
          <EnvironmentComputer key={local.workerId} worker={local} revision={snapshot.revision} onChanged={onChanged} />
        )
      )}
    </>
  );
}
