import { useState } from "react";
import { Provider, type ui } from "@canopy/contracts";
import { Button, Notice, Sheet } from "../../ui/components";
import { SettingsActions, SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { providerName } from "../models/catalog";
import { ProviderForm } from "./ProviderForm";
import { ProviderWorker } from "./ProviderWorker";
import { ProviderModels } from "./ProviderModels";

export function ProviderSettings() {
  const resource = useSettingsResource("providers", async (api) => {
    const [instances, records] = await Promise.all([api.listProviderInstances({}), api.listWorkerRecords({})]);

    return { ...instances, ...records };
  });

  const [scope, setScope] = useState("");
  const [harness, setHarness] = useState(Provider.CODEX);
  const [editing, setEditing] = useState<ui.ProviderInstance | "new">();
  const [selected, setSelected] = useState<ui.ProviderInstance>();
  const changed = () => void resource.reload();

  return (
    <ResourceState resource={resource}>
      <SettingChoice
        title="Scope"
        value={scope}
        onChange={setScope}
        options={[
          { value: "", label: "All workers" },
          ...(resource.data?.records.map((r) => ({ value: r.workerId, label: r.name, description: r.computerName })) ??
            []),
        ]}
      />
      <Button
        secondary
        title="Refresh providers"
        busy={resource.busy}
        onPress={() => void resource.run((api) => api.refreshProviders({ workerId: scope }))}
      />
      <SettingChoice
        title="Agent"
        value={harness}
        onChange={setHarness}
        options={[Provider.CLAUDE, Provider.CODEX, Provider.GROK].map((value) => ({
          value,
          label: providerName(value),
        }))}
      />
      <SettingsGroup
        title="Provider instances"
        actions={<Button title="Add instance" onPress={() => setEditing("new")} />}
      >
        {resource.data?.instances
          .filter((i) => i.harness === harness)
          .map((instance) => (
            <SettingsRow
              key={instance.id}
              title={instance.label || instance.id}
              description={`${providerName(instance.harness)} · ${instance.id} · ${instance.workers.filter((w) => w.enabled).length} ${instance.workers.filter((w) => w.enabled).length === 1 ? "worker" : "workers"}`}
            >
              <SettingsActions>
                <Button
                  secondary
                  title={scope ? "Edit worker settings" : "Edit definition"}
                  onPress={() => (scope ? setSelected(instance) : setEditing(instance))}
                />
                {!scope && <ProviderModels instance={instance} onChanged={changed} />}
                {!instance.builtIn && !scope && (
                  <Button
                    danger
                    title="Delete instance"
                    disabled={resource.busy || instance.threadCount > 0}
                    onPress={() =>
                      confirmAction(
                        "Delete instance",
                        "Threads keep their saved instance. Remove unused instances only.",
                        () =>
                          void resource.run((api) =>
                            api.deleteProviderInstance({
                              harness: instance.harness,
                              id: instance.id,
                              expectedRevision: instance.revision,
                            }),
                          ),
                      )
                    }
                  />
                )}
              </SettingsActions>
            </SettingsRow>
          ))}
        {resource.data && !resource.data.instances.some((i) => i.harness === harness) && (
          <Notice>No instances for this agent yet.</Notice>
        )}
      </SettingsGroup>
      <Sheet
        title={editing === "new" ? "Add instance" : "Edit definition"}
        visible={!!editing}
        onClose={() => setEditing(undefined)}
      >
        {editing && (
          <ProviderForm
            harness={harness}
            instance={editing === "new" ? undefined : editing}
            onSaved={() => {
              setEditing(undefined);
              changed();
            }}
          />
        )}
      </Sheet>
      <Sheet title="Worker provider settings" visible={!!selected} onClose={() => setSelected(undefined)}>
        {selected && <ProviderWorker instance={selected} workerId={scope} onChanged={changed} />}
      </Sheet>
    </ResourceState>
  );
}
