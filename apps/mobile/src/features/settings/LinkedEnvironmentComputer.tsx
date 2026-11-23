import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { Button, Field, Notice } from "../../ui/components";
import { ResourceState, useSettingsResource } from "./resource";
import { SettingsGroup, SettingsRow, SettingChoice, SettingToggle, SettingsActions } from "./SettingsGroup";
import { EnvironmentPreview } from "./EnvironmentPreview";
import { createSettingsViewState } from "./SettingsScroll";

const useOverrideItem = createSettingsViewState("");

export function LinkedEnvironmentComputer({ workerId, reason }: { workerId: string; reason: string }) {
  const resource = useSettingsResource(
    `GetWorkerEnvironment:${workerId}`,
    (api) => api.getWorkerEnvironment({ workerId }),
    !reason,
  );

  const [selection, setSelection] = useOverrideItem(workerId);
  const data = resource.data;
  const worker = data?.worker;
  const item = data?.items.find((row) => itemKey(row) === selection) ?? data?.items[0];
  const override = data?.overrides.find((row) => item && row.kind === item.kind && row.item === item.item);

  const files = [
    ...(worker?.report?.files ?? []),
    ...(worker?.report?.skills ?? []),
    ...(worker?.report?.plugins ?? []),
  ];

  if (reason) return <Notice>{reason}</Notice>;

  return (
    <ResourceState resource={resource}>
      <SettingsActions>
        <Button
          title="Refresh status"
          busy={resource.busy || resource.loading}
          onPress={() => void resource.reload().catch(() => {})}
        />
      </SettingsActions>
      {worker && (
        <>
          <SettingsRow
            title={worker.online ? "Online" : "Offline"}
            description={[...worker.automaticTags, ...worker.manualTags].join(" · ")}
          />
          {!worker.supported && <Notice>Update this worker to sync its agent environment.</Notice>}
          <EnvironmentPreview worker={worker} />
        </>
      )}
      {data && (
        <SettingsGroup title="Machine overrides" description="Changes apply to the saved library on this computer.">
          {item ? (
            <>
              <SettingChoice
                title="Library item"
                value={itemKey(item)}
                disabled={resource.busy}
                onChange={setSelection}
                options={data.items.map((row) => ({ value: itemKey(row), label: row.name, description: row.kind }))}
              />
              <OverrideFields
                key={itemKey(item)}
                item={item}
                override={override}
                revision={data.revision}
                busy={resource.busy}
                onSave={async (values, expectedRevision, remove) =>
                  Boolean(
                    await resource.run(
                      (api) =>
                        api.setWorkerEnvironmentOverride({
                          workerId,
                          expectedRevision,
                          remove,
                          override: { kind: item.kind, item: item.item, ...values },
                        }),
                      remove ? "Override removed on this computer." : "Override saved on this computer.",
                    ),
                  )
                }
              />
            </>
          ) : (
            <SettingsRow
              title="No library items"
              description="Add instructions, a skill or a plugin to set a machine override."
            />
          )}
        </SettingsGroup>
      )}
      {worker && (
        <SettingsGroup title="Files on this computer">
          {files.length ? (
            files.map((file) => <SettingsRow key={file.targetId} title={file.path} description={file.status} />)
          ) : (
            <Notice>Assigned files appear here after the worker’s first sync.</Notice>
          )}
        </SettingsGroup>
      )}
    </ResourceState>
  );
}

const itemKey = (item: ui.WorkerEnvironmentItem) => `${item.kind}:${item.item}`;

type Values = Pick<ui.WorkerEnvironmentOverride, "content" | "disabled" | "versionHash">;

function OverrideFields({
  item,
  override,
  revision,
  busy,
  onSave,
}: {
  item: ui.WorkerEnvironmentItem;
  override?: ui.WorkerEnvironmentOverride;
  revision: bigint;
  busy: boolean;
  onSave: (values: Values, expectedRevision: bigint, remove: boolean) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<{ values: Values; revision: bigint }>();
  const values = draft?.values ?? override ?? { content: "", disabled: false, versionHash: "" };
  const changedOnComputer = !!draft && draft.revision !== revision;

  const change = (patch: Partial<Values>) =>
    setDraft({ values: { ...values, ...patch }, revision: draft?.revision ?? revision });

  async function save(remove: boolean) {
    if (await onSave(values, draft?.revision ?? revision, remove)) setDraft(undefined);
  }

  return (
    <>
      <SettingToggle
        title="Disable on this computer"
        disabled={busy}
        value={values.disabled}
        onChange={(disabled) => change({ disabled })}
      />
      {item.kind === "instruction" && !values.disabled && (
        <Field
          label="Extra instructions"
          multiline
          value={values.content}
          editable={!busy}
          onChangeText={(content) => change({ content })}
        />
      )}
      {item.kind === "skill" && (
        <SettingChoice
          title="Version on this computer"
          disabled={busy}
          value={values.versionHash}
          options={[
            { value: "", label: "Follow library version" },
            ...item.versions.map((version) => ({ value: version.hash, label: `Version ${version.version}` })),
          ]}
          onChange={(versionHash) => change({ versionHash })}
        />
      )}
      {changedOnComputer && <Notice>The library changed. Reload the override before editing it again.</Notice>}
      <SettingsActions>
        {changedOnComputer && <Button title="Reload override" onPress={() => setDraft(undefined)} />}
        <Button
          title="Remove override"
          disabled={busy || !override || changedOnComputer}
          onPress={() => void save(true)}
        />
        <Button
          title="Save override"
          variant="primary"
          disabled={busy || changedOnComputer}
          onPress={() => void save(false)}
        />
      </SettingsActions>
    </>
  );
}
