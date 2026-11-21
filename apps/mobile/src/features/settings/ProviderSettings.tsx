import { useState } from "react";
import { Text } from "react-native";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { instanceName } from "@canopy/domain/provider-instances";
import { useOverview } from "../../state/overview";
import { Alert, Button, IconButton, Sheet } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { useTimeLabel } from "../../ui/time";
import { useWorkerRecordOptions } from "../computers/worker-options";
import { providerName } from "../models/catalog";
import { InstanceDetail } from "../providers/InstanceDetail";
import { InstanceRow } from "../providers/InstanceRow";
import { ConfigNoticesFor } from "./ConfigNoticesFor";
import { ProviderForm } from "./ProviderForm";
import { SettingChoice, SettingsGroup } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";

const keyOf = (instance: Pick<ui.ProviderInstance, "harness" | "id">) => `${instance.harness}:${instance.id}`;

/** The overview's live account and plan usage over the listed instance (web: ProvidersState.updateUsage). */
function live(instance: ui.ProviderInstance, workers: readonly ui.Worker[]): ui.ProviderInstance {
  return create(ui.ProviderInstanceSchema, {
    ...instance,
    workers: instance.workers.map((on) => {
      const current = workers
        .find((w) => w.id === on.workerId)
        ?.providerInstances.find((i) => i.harness === instance.harness && i.id === instance.id);

      return current
        ? create(ui.InstanceOnWorkerSchema, { ...on, usage: current.usage, account: current.account ?? on.account })
        : on;
    }),
  });
}

/**
 * Settings → Providers (web: settings/providers): instances defined once in the gateway and turned on per worker.
 * The scope picks where changes apply; a row's switch turns the instance on or off there, the row opens its detail.
 */
export function ProviderSettings() {
  const c = useColors();
  const overview = useOverview();

  const resource = useSettingsResource("ListProviderInstances+ListWorkerRecords", async (api) => {
    const [instances, records] = await Promise.all([api.listProviderInstances({}), api.listWorkerRecords({})]);

    return { ...instances, ...records };
  });

  const [scope, setScope] = useState("");
  const [selectedKey, setSelected] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [toggling, setToggling] = useState<string>();
  const [refresh, setRefresh] = useState<{ busy: boolean; checked: boolean; skipped: string[] }>();
  const minute = useTimeLabel((time) => String(Math.floor(time / 60_000)), true);
  const now = Number(minute) * 60_000;
  const workerOptions = useWorkerRecordOptions(resource.data?.records ?? []);
  const record = resource.data?.records.find((w) => w.workerId === scope);

  const worker = scope
    ? (overview.workers.find((w) => w.id === scope) ??
      create(ui.WorkerSchema, { id: scope, name: record?.name ?? "Worker", nodeId: record?.nodeId, os: record?.os }))
    : undefined;

  const changed = () => void resource.reload();

  const instances = (
    resource.data?.instances ??
    (resource.initialLoading
      ? [create(ui.ProviderInstanceSchema, { id: "native", label: " ", harness: Provider.CODEX, builtIn: true })]
      : [])
  ).map((instance) => live(instance, overview.workers));

  const selected = instances.find((i) => keyOf(i) === selectedKey);

  async function refreshAll() {
    setRefresh({ busy: true, checked: false, skipped: [] });
    const result = await resource.run((api) => api.refreshProviders({ workerId: scope }));
    setRefresh({ busy: false, checked: !!result, skipped: result?.skipped ?? [] });
  }

  async function toggle(instance: ui.ProviderInstance, enabled: boolean) {
    setToggling(keyOf(instance));
    await resource.run<unknown>(
      (api) =>
        worker
          ? api.setInstanceWorker({ harness: instance.harness, id: instance.id, workerId: worker.id, enabled })
          : api.setInstanceWorkers({ harness: instance.harness, id: instance.id, allWorkers: enabled, workerIds: [] }),
      `${instanceName(instance)} turned ${enabled ? "on" : "off"} on ${worker?.name ?? "all workers"}`,
    );
    setToggling(undefined);
  }

  return (
    <ResourceState resource={resource}>
      <SettingChoice
        title="Scope"
        value={scope}
        onChange={setScope}
        options={[{ value: "", label: "All workers" }, ...workerOptions]}
      />
      <ConfigNoticesFor
        match={(n) => n.kind === "instance" && n.field === "deleted" && !n.localId}
        onChanged={changed}
      />
      {refresh?.skipped.length ? <Alert tone="info">Not checked: {refresh.skipped.join("; ")}</Alert> : null}
      {worker && !worker.online ? (
        <Alert tone="info">{worker.name} is offline. Changes are saved and reach it when it connects.</Alert>
      ) : null}
      <SettingsGroup
        title="Providers"
        description={refresh?.busy ? "Checking…" : refresh?.checked ? "Checked just now" : undefined}
        actions={
          <>
            <IconButton
              icon="arrow-path"
              label="Refresh providers"
              busy={refresh?.busy}
              onPress={() => void refreshAll()}
            />
            <Button icon="plus" title="Add" label="Add provider" onPress={() => setAdding(true)} />
          </>
        }
      >
        {instances.map((instance) => (
          <InstanceRow
            key={keyOf(instance)}
            instance={instance}
            worker={worker}
            busy={toggling === keyOf(instance)}
            disabled={resource.busy}
            onSelect={() => setSelected(keyOf(instance))}
            onToggle={(enabled) => void toggle(instance, enabled)}
          />
        ))}
        {resource.data && !instances.length ? (
          <Text style={[styles.chrome, { color: c.muted }]}>No provider instances yet.</Text>
        ) : null}
      </SettingsGroup>
      <Sheet
        title={selected ? instanceName(selected) : "Provider"}
        visible={!!selected}
        onClose={() => setSelected(undefined)}
      >
        {selected && (
          <InstanceDetail
            key={`${keyOf(selected)}:${scope}`}
            instance={selected}
            worker={worker}
            workers={overview.workers}
            workerOptions={workerOptions.map((o) => ({ id: o.value, name: o.label }))}
            now={now}
            busy={resource.busy}
            run={resource.run}
            onChanged={changed}
          />
        )}
      </Sheet>
      <AddProvider visible={adding} onClose={() => setAdding(false)} onAdded={changed} />
    </ResourceState>
  );
}

/** A new instance: its agent first, then the definition and where it runs (web: AddInstanceDialog). */
function AddProvider({ visible, onClose, onAdded }: { visible: boolean; onClose: () => void; onAdded: () => void }) {
  const [harness, setHarness] = useState(Provider.CODEX);

  return (
    <Sheet title="Add provider" visible={visible} onClose={onClose}>
      {visible && (
        <>
          <SettingChoice
            title="Agent"
            value={harness}
            onChange={setHarness}
            options={[Provider.CLAUDE, Provider.CODEX, Provider.GROK].map((value) => ({
              value,
              label: providerName(value),
            }))}
          />
          <ProviderForm
            key={harness}
            harness={harness}
            onSaved={() => {
              onClose();
              onAdded();
            }}
          />
        </>
      )}
    </Sheet>
  );
}
