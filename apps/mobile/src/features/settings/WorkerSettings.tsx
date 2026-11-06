import { useState } from "react";
import { View } from "react-native";
import { ui } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { Button, Notice, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { WorkerCliSettings } from "./WorkerCliSettings";
import { WorkerEnrollment } from "./WorkerEnrollment";
import { WorkerSsh } from "./WorkerSsh";
import { UpdateSettings } from "./UpdateSettings";
import { useDateTime } from "./display";

export function WorkerSettings() {
  const resource = useSettingsResource("workers", async (api) => {
    const [overview, setup, environment, records] = await Promise.all([
      api.getOverview({}),
      api.getWorkerSetup({}),
      api.getAgentEnvironment({}),
      api.listWorkerRecords({}),
    ]);

    return { overview, setup, environment, records };
  });

  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState("");
  const format = useDateTime();
  const settings = useAppearance();
  const data = resource.data;
  const workers = data?.overview.workers ?? [];
  const selectedWorker = workers.find((w) => w.id === selected);

  return (
    <ResourceState resource={resource}>
      <Notice>
        Your machines, connected to Canopy. {workers.filter((w) => w.online).length} of {workers.length} connected.
      </Notice>
      <Button title="Add worker" disabled={!data} onPress={() => setAdding(true)} />
      <SettingsGroup title="Workers">
        {workers.map((worker) => (
          <SettingsRow
            key={worker.id}
            title={worker.name}
            description={`${worker.hostname} · ${worker.os} ${worker.arch} · ${worker.revokedAt ? "Revoked" : worker.online ? "Connected" : "Disconnected"}`}
            onPress={() => setSelected(worker.id)}
          />
        ))}
        {data && !workers.length && (
          <SettingsRow
            title="No workers yet"
            description="Add a worker to run Claude, Codex or Grok on a computer you control."
          />
        )}
      </SettingsGroup>
      <SettingsGroup title="Pending enrollments">
        {data?.setup.enrollments
          .filter((e) => !e.usedAt && !e.revokedAt)
          .map((e) => (
            <SettingsRow
              key={e.id}
              title={e.name}
              description={`Waiting for enrollment · expires ${format(e.expiresAt?.seconds)}`}
              control={
                <Button
                  secondary
                  title="Revoke"
                  disabled={resource.busy}
                  onPress={() => void resource.run((api) => api.revokeWorkerEnrollment({ id: e.id }))}
                />
              }
            />
          ))}
      </SettingsGroup>
      <SettingsGroup title="Agent CLI updates" description="Account · Workers can override this schedule.">
        <WorkerCliSettings />
      </SettingsGroup>
      <UpdateSettings />
      <SettingsGroup title="Install over SSH">
        <View style={{ padding: 12 }}>
          <WorkerSsh />
        </View>
      </SettingsGroup>
      <SettingsGroup title="Worker connection">
        <SettingsValue
          title="Gateway address"
          value={data?.setup.gatewayUrl}
          description="Used for new worker installations. Existing workers keep their working connection."
        />
        <SettingsInput
          title="Gateway address"
          value={settings.user?.workerGatewayUrl ?? ""}
          busy={settings.saving}
          onSave={async (workerGatewayUrl) => {
            await settings.update({ workerGatewayUrl });
            await resource.reload();

            return true;
          }}
        />
      </SettingsGroup>
      {adding && data && (
        <WorkerEnrollment
          setup={data.setup}
          onClose={() => {
            setAdding(false);
            void resource.reload();
          }}
        />
      )}
      <Sheet title={selectedWorker?.name || "Worker"} visible={!!selectedWorker} onClose={() => setSelected("")}>
        {selectedWorker && data && (
          <WorkerDetails
            key={selectedWorker.id}
            worker={selectedWorker}
            setup={data.setup}
            environment={data.environment}
            readOnly={data.records.records.find((r) => r.workerId === selectedWorker.id)?.readOnlyReason || ""}
            onChanged={() => void resource.reload()}
            onClose={() => setSelected("")}
          />
        )}
      </Sheet>
    </ResourceState>
  );
}

function WorkerDetails({
  worker,
  setup,
  environment,
  readOnly,
  onChanged,
  onClose,
}: {
  worker: ui.Worker;
  setup: ui.GetWorkerSetupResponse;
  environment: ui.AgentEnvironmentSnapshot;
  readOnly: string;
  onChanged: () => void;
  onClose: () => void;
}) {
  const resource = useSettingsResource(`worker:${worker.id}`, (api) => api.getWorkerSetup({}));
  const tags = environment.workers.find((w) => w.workerId === worker.id);
  const disabled = resource.busy || !!readOnly;
  const own = !worker.nodeId;

  return (
    <ResourceState resource={resource}>
      {readOnly ? <Notice>{readOnly} These are the last saved settings.</Notice> : null}
      <SettingsGroup title="Machine details">
        <SettingsValue title="Hostname" value={worker.hostname} />
        <SettingsValue title="System" value={`${worker.os} ${worker.arch}`} />
        <SettingsValue title="Canopy version" value={worker.version} />
        <SettingsValue title="Configuration" value={`${worker.appliedVersion} / ${worker.configVersion}`} />
        {worker.configIssues.map((issue, index) => (
          <SettingsValue key={index} title="Configuration issue" value={issue.message} />
        ))}
        <SettingsValue
          title="Connection"
          value={worker.networkRouteStatus?.route}
          description={worker.networkRouteStatus?.detail}
        />
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
      </SettingsGroup>
      <SettingsGroup title="Worker tags">
        <SettingsValue title="Automatic tags" value={tags?.automaticTags.join(", ")} />
        <SettingsInput
          title="Manual tags"
          description="One tag per line."
          value={tags?.manualTags.join("\n") || ""}
          multiline
          busy={disabled || !own}
          onSave={async (value) => {
            const result = await resource.run((api) =>
              api.setEnvironmentTags({
                workerId: worker.id,
                tags: value
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
                expectedRevision: environment.revision,
              }),
            );

            onChanged();

            return !!result;
          }}
        />
      </SettingsGroup>
      <SettingsGroup
        title="Agent CLIs"
        description="Installed on this machine. Nothing changes until you install or update."
      >
        <WorkerCliSettings worker={worker} readOnly={readOnly} />
      </SettingsGroup>
      <SettingsGroup title="Provider accounts">
        {worker.providerInstances
          .filter((i) => i.enabled)
          .map((i) => (
            <SettingsValue
              key={`${i.harness}/${i.id}`}
              title={i.label || i.id}
              value={i.status?.auth || i.detail || (i.available ? "Available" : "Unavailable")}
            />
          ))}
      </SettingsGroup>
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
  const resource = useSettingsResource(`worker-access:${worker.id}`, (api) => api.getWorkerSetup({}));
  const [credential, setCredential] = useState("");
  const disabled = resource.busy || !!readOnly;

  return (
    <ResourceState resource={resource}>
      <SettingsGroup title="Access">
        <SettingsRow
          title="Rotate credential"
          description="Disconnect this worker and replace its credential. The new credential is shown once."
          control={
            <Button
              secondary
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
              danger
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
              danger
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
      </SettingsGroup>
    </ResourceState>
  );
}
