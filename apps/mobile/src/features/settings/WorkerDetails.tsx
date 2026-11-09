import { useState } from "react";
import { ui } from "@canopy/contracts";
import { openSettingsSection } from "./navigation";
import { Button, Notice } from "../../ui/components";
import { SettingsRow, SettingsSection } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { WorkerCliSettings } from "./WorkerCliSettings";
import { WorkerProviderAccounts } from "./WorkerProviderAccounts";
import { providerName } from "../models/catalog";
import { useWorkerPresence } from "../computers/presence";
import { router } from "expo-router";

export function WorkerDetails({
  worker,
  setup,
  environment,
  record,
  onChanged,
  onClose,
}: {
  worker: ui.Worker;
  setup: ui.GetWorkerSetupResponse;
  environment: ui.AgentEnvironmentSnapshot;
  record?: ui.WorkerRecord;
  onChanged: () => void;
  onClose: () => void;
}) {
  const resource = useSettingsResource("GetWorkerSetup", (api) => api.getWorkerSetup({}));
  const tags = record ?? environment.workers.find((w) => w.workerId === worker.id);

  const readOnly =
    useWorkerPresence()(worker).reason ||
    record?.readOnlyReason ||
    (worker.nodeId && !record ? "Manage this worker on its own computer. Configuration is not shared." : "");

  const disabled = resource.busy || !!readOnly;
  const own = !worker.nodeId;

  return (
    <ResourceState resource={resource} gap={0}>
      {readOnly ? <Notice>{readOnly} These are the last saved settings.</Notice> : null}
      {own && worker.cliImport && (
        <Button
          title="Import CLI threads"
          disabled={!worker.online}
          onPress={() => {
            onClose();
            router.push({ pathname: "/settings/[section]", params: { section: "import", worker: worker.id } });
          }}
        />
      )}
      <SettingsSection title="Agent CLIs" description="Nothing changes until you install or update.">
        <WorkerCliSettings worker={worker} readOnly={readOnly} onChanged={onChanged} />
      </SettingsSection>
      <SettingsSection
        title="Configuration"
        actions={<Button title="Manage providers" onPress={() => openSettingsSection("providers")} />}
      >
        <SettingsValue
          title="Providers"
          value={
            worker.providerInstances
              .filter((i) => i.enabled)
              .map((i) => `${providerName(i.harness)} · ${i.label || i.id}`)
              .join(", ") || "None"
          }
        />
        <SettingsValue
          title="Version"
          value={`v${worker.appliedVersion}${worker.appliedVersion !== worker.configVersion ? ` · v${worker.configVersion} pending` : ""}`}
        />
        {worker.configIssues.map((issue, index) => (
          <SettingsValue key={index} title={issue.path || "Configuration issue"} value={issue.message} />
        ))}
      </SettingsSection>
      <WorkerProviderAccounts worker={worker} readOnly={readOnly} />
      <SettingsSection title="Tags">
        <SettingsValue title="Automatic tags" value={tags?.automaticTags.join(", ")} />
        <SettingsInput
          title="Manual tags"
          description="Groups for instruction, skill and plugin assignments. Use up to 32 tags, one per line."
          value={tags?.manualTags.join("\n") || ""}
          multiline
          busy={disabled || (!own && !record)}
          onSave={async (value) => {
            const result = await resource.run((api) =>
              api.setEnvironmentTags({
                workerId: worker.id,
                tags: value
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
                expectedRevision: record ? 0n : environment.revision,
              }),
            );

            onChanged();

            return !!result;
          }}
        />
      </SettingsSection>
      <SettingsSection title="Worker actions">
        <SettingsInput
          title="Machine name"
          value={worker.name}
          busy={disabled}
          onSave={async (name) => {
            const result = await resource.run((api) => api.renameWorker({ workerId: worker.id, name }));
            onChanged();

            return !!result;
          }}
        />
      </SettingsSection>
      {own && (
        <WorkerAccess worker={worker} setup={setup} readOnly={readOnly} onChanged={onChanged} onClose={onClose} />
      )}
    </ResourceState>
  );
}

function WorkerAccess({
  worker,
  setup,
  readOnly,
  onChanged,
  onClose,
}: {
  worker: ui.Worker;
  setup: ui.GetWorkerSetupResponse;
  readOnly: string;
  onChanged: () => void;
  onClose: () => void;
}) {
  const resource = useSettingsResource("GetWorkerSetup", (api) => api.getWorkerSetup({}));
  const [credential, setCredential] = useState("");
  const disabled = resource.busy || !!readOnly;

  return (
    <ResourceState resource={resource}>
      <SettingsSection title="Access">
        <SettingsRow
          title="Rotate credential"
          description="Disconnect this worker and replace its credential. The new credential is shown once."
          control={
            <Button
              title="Rotate credential"
              disabled={disabled || !!worker.revokedAt}
              onPress={() =>
                confirmAction(
                  "Rotate credential",
                  "The old credential stops working now. Copy the new one before closing.",
                  () =>
                    void resource
                      .run((api) => api.rotateWorkerCredential({ workerId: worker.id }))
                      .then((result) => {
                        if (result) setCredential(result.credential);
                        onChanged();
                      }),
                )
              }
            />
          }
        />
        {credential ? (
          <SettingsValue
            title="worker.json · private"
            description="Put this credential in worker.json, keep mode 0600 and restart the worker. Keep data_dir and ca_file."
            value={JSON.stringify({ gateway_url: setup.gatewayUrl, worker_id: worker.id, credential }, null, 2)}
          />
        ) : null}
        <SettingsRow
          title="Revoke worker"
          description="Workspaces, threads and files stay. Processes already running may continue."
          control={
            <Button
              variant="danger"
              title="Revoke worker"
              disabled={disabled || !!worker.revokedAt}
              onPress={() =>
                confirmAction(
                  "Revoke worker",
                  "This worker disconnects and cannot reconnect. Stop the worker on that computer.",
                  () => void resource.run((api) => api.revokeWorker({ workerId: worker.id })).then(onChanged),
                )
              }
            />
          }
        />
        <SettingsRow
          title="Archive worker"
          description="Archives its workspaces. Its threads remain readable. Files stay on the computer."
          control={
            <Button
              variant="danger"
              title="Archive worker"
              disabled={disabled}
              onPress={() =>
                confirmAction(
                  "Archive worker",
                  "This revokes access and archives the workspaces. Stop the worker on that computer.",
                  () =>
                    void resource
                      .run((api) => api.archiveWorker({ workerId: worker.id }))
                      .then((result) => {
                        if (result) onClose();
                        onChanged();
                      }),
                )
              }
            />
          }
        />
      </SettingsSection>
    </ResourceState>
  );
}
