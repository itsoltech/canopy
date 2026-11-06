import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { Button, Notice, Sheet } from "../../ui/components";
import { SettingsActions, SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { InstructionEditor } from "./InstructionEditor";
import { SkillEditor } from "./SkillEditor";
import { SkillSourceEditor } from "./SkillSourceEditor";
import { MarketplaceSettings } from "./MarketplaceSettings";
import { EnvironmentComputer } from "./EnvironmentComputer";
import { SettingsSkeletonGroups } from "./SettingsSkeleton";

export function AgentEnvironmentSettings() {
  const resource = useSettingsResource("agent-environment", (api) => api.getAgentEnvironment({}));
  const [editor, setEditor] = useState<"instruction" | "skill" | "source">();
  const [document, setDocument] = useState<ui.InstructionDocument>();
  const [skill, setSkill] = useState<ui.LibrarySkill>();
  const [workerId, setWorker] = useState("");
  const snapshot = resource.data;

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
      <Button secondary title="Refresh status" busy={resource.busy} onPress={() => void resource.reload()} />
      {resource.initialLoading && (
        <SettingsSkeletonGroups titles={["Instructions", "Skills", "Marketplaces", "Computers"]} />
      )}
      {snapshot && (
        <>
          <SettingsGroup
            title="Instructions"
            actions={<Button title="Add instructions" onPress={() => add("instruction")} />}
          >
            {!snapshot.documents.length && (
              <SettingsRow
                title="No instructions yet"
                description="Add a document to share instructions across your computers."
              />
            )}
            {snapshot.documents.map((doc) => (
              <InstructionRow
                key={doc.id}
                document={doc}
                busy={resource.busy}
                onEdit={() => {
                  setDocument(doc);
                  setEditor("instruction");
                }}
                onDelete={() => removeDocument(doc.id)}
              />
            ))}
          </SettingsGroup>
          <SettingsGroup title="Skills" actions={<Button title="Add skill" onPress={() => add("skill")} />}>
            <Button secondary title="Add from Git" onPress={() => add("source")} />
            {!snapshot.skills.length && (
              <SettingsRow title="No skills yet" description="Add a skill folder, ZIP or Git source." />
            )}
            {snapshot.skills.map((item) => (
              <SettingsRow
                key={item.id}
                title={item.name}
                description={`${item.harnesses.join(" · ")} · Version ${item.version} · ${item.artifact?.files.length ?? 0} files${item.source?.pinned ? " · Pinned" : item.source?.autoUpdate ? " · Automatic updates" : ""}`}
              >
                <Button
                  secondary
                  title="Edit skill"
                  onPress={() => {
                    setSkill(item);
                    setEditor("skill");
                  }}
                />
                {item.source && (
                  <Button
                    secondary
                    title="Check upstream"
                    onPress={() => {
                      setSkill(item);
                      setEditor("source");
                    }}
                  />
                )}
                {item.source?.error && <Notice error>Could not check the source. Check upstream to retry.</Notice>}
                <DeleteEnvironmentItem
                  title="Delete skill"
                  disabled={resource.busy}
                  onDelete={() =>
                    void resource.run((api) =>
                      api.deleteLibrarySkill({ id: item.id, expectedRevision: snapshot.revision }),
                    )
                  }
                />
              </SettingsRow>
            ))}
          </SettingsGroup>
          <MarketplaceSettings snapshot={snapshot} onChanged={() => void resource.reload()} />
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
  busy,
  onEdit,
  onDelete,
}: {
  document: ui.InstructionDocument;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <SettingsRow
      title={document.name}
      description={`${document.harness} · ${document.fragments.length} ${document.fragments.length === 1 ? "fragment" : "fragments"} · ${document.selector?.everyone ? "All computers" : "Selected computers and tags"}`}
    >
      <SettingsActions>
        <Button secondary title="Edit instructions" onPress={onEdit} />
        <Button danger title="Delete instructions" disabled={busy} onPress={onDelete} />
      </SettingsActions>
    </SettingsRow>
  );
}

function DeleteEnvironmentItem({
  title,
  disabled,
  onDelete,
}: {
  title: string;
  disabled: boolean;
  onDelete: () => void;
}) {
  return (
    <Button
      danger
      title={title}
      disabled={disabled}
      onPress={() =>
        confirmAction(title, "This removes its assignment. Local edits stay available for review.", onDelete)
      }
    />
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
