import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import * as Crypto from "expo-crypto";
import { ui } from "@canopy/contracts";
import { Button, Field, IconButton, Notice } from "../../ui/components";
import { SettingsActions, SettingsGroup, SettingChoice, SettingToggle } from "./SettingsGroup";
import { EnvironmentPreview } from "./EnvironmentPreview";
import { ResourceState, useSettingsResource } from "./resource";
import { EnvironmentAssignment } from "./EnvironmentAssignment";
import { EnvironmentWizard } from "./EnvironmentWizard";

export function InstructionEditor({
  document,
  snapshot,
  conflict,
  onSaved,
}: {
  document?: ui.InstructionDocument;
  snapshot: ui.AgentEnvironmentSnapshot;
  conflict: boolean;
  onSaved: () => void;
}) {
  const resource = useSettingsResource("GetAgentEnvironment", (api) => api.getAgentEnvironment({}));

  const [draft, setDraft] = useState(() =>
    create(
      ui.InstructionDocumentSchema,
      document ?? {
        harness: "claude",
        platformHome: true,
        deviceHome: true,
        selector: { everyone: true },
        fragments: [{ id: Crypto.randomUUID(), name: "Base instructions", content: "" }],
      },
    ),
  );

  const [workerId, setWorker] = useState(snapshot.workers[0]?.workerId ?? "");
  const worker = snapshot.workers.find((item) => item.workerId === workerId);

  const change = (patch: Partial<ui.InstructionDocument>) => {
    setDraft(create(ui.InstructionDocumentSchema, { ...draft, ...patch }));
  };

  return (
    <ResourceState resource={resource}>
      <EnvironmentWizard
        steps={["Write instructions", "Assign computers", "Preview & confirm"]}
        busy={resource.busy}
        title={document ? "Save and sync" : "Add and sync"}
        disabled={conflict || !draft.name.trim() || (!draft.platformHome && !draft.deviceHome)}
        onSave={() =>
          void resource
            .run((api) => api.saveInstructionDocument({ document: draft, expectedRevision: snapshot.revision }))
            .then((r) => {
              if (r) onSaved();
            })
        }
      >
        {(step) =>
          step === 0 ? (
            <InstructionFragments draft={draft} workers={snapshot.workers} change={change} />
          ) : step === 1 ? (
            <>
              <SettingToggle
                title="Canopy sessions"
                value={draft.platformHome}
                onChange={(platformHome) => change({ platformHome })}
              />
              <SettingToggle
                title="Device CLI too"
                value={draft.deviceHome}
                onChange={(deviceHome) => change({ deviceHome })}
              />
              <EnvironmentAssignment
                value={draft.selector}
                workers={snapshot.workers}
                onChange={(selector) => change({ selector })}
              />
              {snapshot.workers.map((worker) => (
                <InstructionOverride
                  key={worker.workerId}
                  worker={worker}
                  document={draft}
                  onChange={(overrides) => change({ overrides })}
                />
              ))}
            </>
          ) : (
            <>
              {worker && (
                <SettingChoice
                  title="Preview computer"
                  value={workerId}
                  options={snapshot.workers.map((w) => ({ value: w.workerId, label: w.name }))}
                  onChange={setWorker}
                />
              )}
              {worker ? (
                <EnvironmentPreview key={worker.workerId} worker={worker} draft={draft} />
              ) : (
                <Notice>Add a worker to preview these instructions.</Notice>
              )}
            </>
          )
        }
      </EnvironmentWizard>
    </ResourceState>
  );
}

function InstructionFragments({
  draft,
  workers,
  change,
}: {
  draft: ui.InstructionDocument;
  workers: ui.EnvironmentWorker[];
  change: (patch: Partial<ui.InstructionDocument>) => void;
}) {
  const fragment = (index: number, patch: Partial<ui.InstructionFragment>) =>
    change({
      fragments: draft.fragments.map((f, i) =>
        i === index ? create(ui.InstructionFragmentSchema, { ...f, ...patch }) : f,
      ),
    });

  const move = (index: number, direction: number) => {
    const list = [...draft.fragments];
    const item = list.splice(index, 1)[0];

    if (item) list.splice(index + direction, 0, item);
    change({ fragments: list });
  };

  return (
    <>
      <Field label="Document name" maxLength={120} value={draft.name} onChangeText={(name) => change({ name })} />
      <SettingChoice
        title="Agent file"
        value={draft.harness}
        options={[
          { value: "claude", label: "Claude Code · CLAUDE.md" },
          { value: "codex", label: "Codex · AGENTS.md" },
        ]}
        onChange={(harness) => change({ harness })}
      />
      {draft.fragments.map((f, index) => (
        <SettingsGroup key={f.id} title={`Fragment ${index + 1}`}>
          <Field
            label="Fragment name"
            maxLength={120}
            value={f.name}
            onChangeText={(name) => fragment(index, { name })}
          />
          <Field
            label="Instructions"
            multiline
            value={f.content}
            onChangeText={(content) => fragment(index, { content })}
          />
          <SettingToggle
            title="Inherit document assignment"
            value={!f.selector}
            onChange={(inherit) =>
              fragment(index, {
                selector: inherit ? undefined : create(ui.EnvironmentSelectorSchema, { everyone: true }),
              })
            }
          />
          {f.selector && (
            <EnvironmentAssignment
              value={f.selector}
              workers={workers}
              onChange={(selector) => fragment(index, { selector })}
            />
          )}
          <SettingsActions>
            <IconButton
              icon="arrow-up"
              label="Move fragment up"
              disabled={index === 0}
              onPress={() => move(index, -1)}
            />
            <IconButton
              icon="arrow-down"
              label="Move fragment down"
              disabled={index === draft.fragments.length - 1}
              onPress={() => move(index, 1)}
            />
            <Button
              title="Remove fragment"
              onPress={() => change({ fragments: draft.fragments.filter((v) => v.id !== f.id) })}
            />
          </SettingsActions>
        </SettingsGroup>
      ))}
      <Button
        title="Add fragment"
        disabled={draft.fragments.length >= 64}
        onPress={() =>
          change({ fragments: [...draft.fragments, create(ui.InstructionFragmentSchema, { id: Crypto.randomUUID() })] })
        }
      />
    </>
  );
}

function InstructionOverride({
  worker,
  document,
  onChange,
}: {
  worker: ui.EnvironmentWorker;
  document: ui.InstructionDocument;
  onChange: (v: ui.InstructionMachineOverride[]) => void;
}) {
  const current = document.overrides.find((o) => o.workerId === worker.workerId);

  const change = (patch: Partial<ui.InstructionMachineOverride>) =>
    onChange([
      ...document.overrides.filter((o) => o.workerId !== worker.workerId),
      create(ui.InstructionMachineOverrideSchema, {
        ...create(ui.InstructionMachineOverrideSchema, current),
        workerId: worker.workerId,
        ...patch,
      }),
    ]);

  return (
    <SettingsGroup title={`${worker.name} · override`}>
      <SettingToggle
        title="Disabled on this computer"
        value={current?.disabled ?? false}
        onChange={(disabled) => change({ disabled })}
      />
      <Field
        label="Additional instructions"
        value={current?.content ?? ""}
        multiline
        onChangeText={(content) => change({ content })}
      />
    </SettingsGroup>
  );
}
