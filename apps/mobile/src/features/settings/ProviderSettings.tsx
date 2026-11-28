import { useState } from "react";
import { useLocalSearchParams, useRoute } from "expo-router";
import { Text } from "react-native";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { instanceName } from "@canopy/domain/provider-instances";
import { useOverview } from "../../state/overview";
import { Alert, Button, IconButton, Sheet } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { useTimeLabel } from "../../ui/time";
import { useWorkerRecordOptions } from "../computers/worker-options";
import { AddProvider } from "./AddProvider";
import { InstanceDetail } from "../providers/InstanceDetail";
import { InstanceRow } from "../providers/InstanceRow";
import { ProviderProxyLimits } from "../providers/ProviderProxyLimits";
import { ConfigNoticesFor } from "./ConfigNoticesFor";
import { SettingChoice, SettingsActions, SettingsGroup } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";

import { createSettingsViewState } from "./SettingsScroll";

const useProviderScope = createSettingsViewState("");
const useSelectedInstance = createSettingsViewState<string | undefined>(undefined);

const keyOf = (instance: Pick<ui.ProviderInstance, "harness" | "id">) => `${instance.harness}:${instance.id}`;

/** The overview's live account and plan usage over the listed instance (web: ProvidersState.updateUsage). */
function live(
  instance: ui.ProviderInstance,
  workers: readonly ui.Worker[],
  records: readonly ui.WorkerRecord[],
): ui.ProviderInstance {
  const linked = records.flatMap((record) => {
    if (instance.workers.some((on) => on.workerId === record.workerId)) return [];
    const saved = record.instances.find((item) => item.id === instance.id && item.harness === instance.harness);

    const reported = workers
      .find((w) => w.id === record.workerId)
      ?.providerInstances.find((item) => item.id === instance.id && item.harness === instance.harness);

    if (reported?.status) return create(ui.InstanceOnWorkerSchema, { ...reported.status, workerId: record.workerId });

    return create(ui.InstanceOnWorkerSchema, {
      enabled: reported?.enabled ?? saved?.enabled ?? instance.allWorkers,
      explicit: saved?.enabled !== undefined,
      detail: `Status from ${record.computerName || record.name} unavailable`,
      overrides: { apiKeySet: saved?.keySet ?? false },
      workerId: record.workerId,
    });
  });

  return create(ui.ProviderInstanceSchema, {
    ...instance,
    workers: [...instance.workers, ...linked].map((on) => {
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
function useProviderPanel() {
  const overview = useOverview();

  const resource = useSettingsResource("ListProviderInstances+ListWorkerRecords", async (api) => {
    const [instances, records] = await Promise.all([api.listProviderInstances({}), api.listWorkerRecords({})]);

    return { ...instances, ...records };
  });

  const initial = useLocalSearchParams<{ worker?: string }>();
  const route = useRoute();
  const entry = initial.worker ? route.key : undefined;
  const [scope, setScope] = useProviderScope(entry, initial.worker ?? "");
  const [selectedKey, setSelected] = useSelectedInstance(entry);
  const workerOptions = useWorkerRecordOptions(resource.data?.records ?? []);
  const record = resource.data?.records.find((w) => w.workerId === scope);

  const worker = scope
    ? (overview.workers.find((w) => w.id === scope) ??
      create(ui.WorkerSchema, { id: scope, name: record?.name ?? "Worker", nodeId: record?.nodeId, os: record?.os }))
    : undefined;

  const readOnly =
    (scope && !workerOptions.some((option) => option.value === scope) ? "This worker is unavailable." : "") ||
    (record?.readOnlyReason ??
      (worker?.nodeId ? "Manage this worker on its own computer. Configuration is not shared." : ""));

  const changed = () => void resource.reload();

  const instances = (
    resource.data?.instances ??
    (resource.initialLoading
      ? [create(ui.ProviderInstanceSchema, { id: "native", label: " ", harness: Provider.CODEX, builtIn: true })]
      : [])
  ).map((instance) => live(instance, overview.workers, resource.data?.records ?? []));

  const selected = instances.find((i) => keyOf(i) === selectedKey);

  const [toggling, setToggling] = useState<string>();
  const [refresh, setRefresh] = useState<{ busy: boolean; checked: boolean; skipped: string[] }>();

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

  return {
    refresh,
    refreshAll,
    toggling,
    toggle,
    resource,
    scope,
    setScope,
    selected,
    setSelected,
    workerOptions,
    worker,
    readOnly,
    changed,
    instances,
    workers: overview.workers,
  };
}

export function ProviderSettings() {
  const {
    refresh,
    refreshAll,
    toggling,
    toggle,
    resource,
    scope,
    setScope,
    selected,
    setSelected,
    workerOptions,
    worker,
    readOnly,
    changed,
    instances,
    workers,
  } = useProviderPanel();

  const c = useColors();
  const [adding, setAdding] = useState(false);
  const minute = useTimeLabel((time) => String(Math.floor(time / 60_000)), true);
  const now = Number(minute) * 60_000;

  return (
    <ResourceState resource={resource}>
      <ProviderProxyLimits now={now} />
      <SettingChoice
        title="Applying settings on"
        value={scope}
        disabled={resource.busy}
        onChange={setScope}
        options={[{ value: "", label: "All workers" }, ...workerOptions]}
      />
      <ConfigNoticesFor
        match={(n) => n.kind === "instance" && n.field === "deleted" && !n.localId}
        onChanged={changed}
      />
      {refresh?.skipped.length ? <Alert tone="info">Not checked: {refresh.skipped.join("; ")}</Alert> : null}
      {readOnly ? (
        <Alert tone="info">{readOnly}</Alert>
      ) : worker && !worker.online ? (
        <Alert tone="info">{worker.name} is offline. Changes are saved and reach it when it connects.</Alert>
      ) : null}
      <SettingsGroup
        title="Providers"
        description={refresh?.busy ? "Checking…" : refresh?.checked ? "Checked just now" : undefined}
        actions={
          <SettingsActions>
            <IconButton
              icon="arrow-path"
              label="Refresh providers"
              busy={refresh?.busy}
              onPress={() => void refreshAll()}
            />
            <Button
              icon="plus"
              title="Add"
              label="Add provider"
              disabled={!!readOnly}
              onPress={() => setAdding(true)}
            />
          </SettingsActions>
        }
      >
        {instances.map((instance) => (
          <InstanceRow
            key={keyOf(instance)}
            instance={instance}
            worker={worker}
            busy={toggling === keyOf(instance)}
            disabled={resource.busy || !!readOnly}
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
            readOnly={readOnly}
            worker={worker}
            workers={workers}
            workerOptions={workerOptions.map((o) => ({ id: o.value, name: o.label }))}
            now={now}
            busy={resource.busy}
            run={resource.run}
            onChanged={changed}
          />
        )}
      </Sheet>
      <Sheet title="Add provider" visible={adding} onClose={() => setAdding(false)}>
        {adding && (
          <AddProvider
            initialWorkerId={scope}
            instances={instances}
            onSaved={(instance) => {
              setAdding(false);
              changed();

              if (instance) setSelected(keyOf(instance));
            }}
          />
        )}
      </Sheet>
    </ResourceState>
  );
}
