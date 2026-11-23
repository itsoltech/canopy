import { useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { harnessName, instanceName, kindLabel } from "@canopy/domain/provider-instances";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/components";
import { font, styles, useColors } from "../../ui/theme";
import { ConfigNoticesFor } from "../settings/ConfigNoticesFor";
import { ProviderForm } from "../settings/ProviderForm";
import { ProviderModels } from "../settings/ProviderModels";
import { WorkerOverrides } from "../settings/WorkerOverrides";
import { SettingAccess } from "../settings/SettingAccess";
import { SettingsGroup, SettingsSection } from "../settings/SettingsGroup";
import { confirmAction, type SettingsApi } from "../settings/resource";
import { InstanceMark } from "./InstanceRow";
import { InstanceStatus } from "./InstanceStatus";

/**
 * One instance for the chosen scope (web: InstanceDetail): on one worker its status there, sign-in and that
 * worker's overrides; in "All workers" its status everywhere, where it runs, and the definition. Models and deletion
 * are global in both.
 */
export function InstanceDetail({
  instance,
  readOnly,
  worker,
  workers,
  workerOptions,
  now,
  busy,
  run,
  onChanged,
}: {
  instance: ui.ProviderInstance;
  readOnly: string;
  worker: ui.Worker | undefined;
  workers: readonly ui.Worker[];
  workerOptions: { id: string; name: string }[];
  now: number;
  busy: boolean;
  run: Run;
  onChanged: () => void;
}) {
  const c = useColors();
  const [formKey, setFormKey] = useState(0);
  const on = worker ? instance.workers.find((w) => w.workerId === worker.id) : undefined;
  const harness = harnessName(instance.harness).toLowerCase();

  return (
    <View style={{ gap: 16 }}>
      <InstanceHeader instance={instance} />
      <ConfigNoticesFor
        match={(n) => n.kind === "instance" && n.localId === instance.id && n.globalId.startsWith(`${harness}:`)}
        onChanged={onChanged}
      />
      <SettingsSection title="Status">
        <InstanceStatus instance={instance} worker={worker} workers={workers} now={now} />
        {!worker && (
          <SettingsGroup>
            <SettingAccess
              title="Workers"
              description="The instance runs only on the chosen workers."
              options={workerOptions}
              all={instance.allWorkers}
              ids={instance.workers.filter((w) => w.enabled).map((w) => w.workerId)}
              disabled={busy}
              onChange={(next) =>
                void run((api) =>
                  api.setInstanceWorkers({
                    harness: instance.harness,
                    id: instance.id,
                    allWorkers: next.all,
                    workerIds: next.all ? [] : [...next.ids],
                  }),
                ).then(onChanged)
              }
            />
          </SettingsGroup>
        )}
      </SettingsSection>
      {worker ? (
        readOnly ? (
          <Text style={[styles.chrome, { color: c.muted }]}>{readOnly}</Text>
        ) : on?.enabled ? (
          <WorkerOverrides instance={instance} worker={worker} onSaved={onChanged} />
        ) : (
          <Text style={[styles.chrome, { color: c.muted }]}>
            Turn the instance on for {worker.name} to set its overrides there. Name, color and models are shared by all
            workers.
          </Text>
        )
      ) : (
        <ProviderForm
          key={`${instance.revision}/${formKey}`}
          harness={instance.harness}
          instance={instance}
          onSaved={onChanged}
          onDiscard={() => setFormKey((k) => k + 1)}
        />
      )}
      <SettingsSection title="Models" description="What the model picker offers for this instance, on every worker.">
        <ProviderModels instance={instance} onChanged={onChanged} />
      </SettingsSection>
      {!instance.builtIn && <DeleteInstance instance={instance} busy={busy} run={run} onChanged={onChanged} />}
    </View>
  );
}

type Run = <R>(action: (api: SettingsApi) => Promise<R>) => Promise<R | undefined>;

function InstanceHeader({ instance }: { instance: ui.ProviderInstance }) {
  const c = useColors();
  const name = instanceName(instance);

  return (
    <View style={[styles.row, { alignItems: "flex-start", gap: 12 }]}>
      <InstanceMark instance={instance} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text numberOfLines={1} style={[styles.label, { fontFamily: font.semibold, color: c.text }]}>
          {name}
        </Text>
        <Text style={[styles.chrome, { color: c.muted }]}>
          {harnessName(instance.harness)} · {instance.id} · {kindLabel(instance.kind)}
        </Text>
        {instance.builtIn || instance.threadCount > 0 ? (
          <View style={[styles.row, { flexWrap: "wrap" }]}>
            {instance.builtIn ? <Badge>Built-in</Badge> : null}
            {instance.threadCount > 0 ? (
              <Badge tone="sky">{`${instance.threadCount} thread${instance.threadCount === 1 ? "" : "s"}`}</Badge>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function DeleteInstance({
  instance,
  busy,
  run,
  onChanged,
}: {
  instance: ui.ProviderInstance;
  busy: boolean;
  run: Run;
  onChanged: () => void;
}) {
  const name = instanceName(instance);

  return (
    <SettingsSection
      title="Delete instance"
      description={
        instance.threadCount > 0
          ? "Threads use it: turn it off on the workers instead."
          : "Removes it from every worker, with its secrets."
      }
    >
      <View style={styles.row}>
        <Button
          variant="danger"
          icon="trash"
          title={`Delete ${name}`}
          busy={busy}
          disabled={instance.threadCount > 0}
          onPress={() =>
            confirmAction(
              `Delete ${name}`,
              "Its secrets are deleted too.",
              () =>
                void run((api) =>
                  api.deleteProviderInstance({
                    harness: instance.harness,
                    id: instance.id,
                    expectedRevision: instance.revision,
                  }),
                ).then(onChanged),
            )
          }
        />
      </View>
    </SettingsSection>
  );
}
