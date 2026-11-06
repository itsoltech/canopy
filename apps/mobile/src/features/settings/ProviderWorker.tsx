import { useState } from "react";
import * as Linking from "expo-linking";
import { ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { Button, Field, Notice } from "../../ui/components";
import { SettingsGroup, SettingToggle } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsResource } from "./resource";
import { EnvironmentFields, environmentDrafts, environmentInput } from "./EnvironmentFields";

export function ProviderWorker({
  instance,
  workerId,
  onChanged,
}: {
  instance: ui.ProviderInstance;
  workerId: string;
  onChanged: () => void;
}) {
  const resource = useSettingsResource(`instance-worker:${workerId}/${instance.harness}/${instance.id}`, (api) =>
    api.getInstanceWorker({ workerId, harness: instance.harness, id: instance.id }),
  );

  const [login, setLogin] = useState<ui.StartProviderLoginResponse>();

  const worker =
    resource.data?.worker ?? (resource.initialLoading ? create(ui.InstanceOnWorkerSchema, { workerId }) : undefined);

  const request = { workerId, harness: instance.harness, id: instance.id };

  return (
    <ResourceState resource={resource}>
      {worker && (
        <>
          <SettingToggle
            title="Enabled on this worker"
            value={worker.enabled}
            disabled={resource.busy}
            onChange={(enabled) =>
              void resource.run((api) => api.setInstanceWorker({ ...request, enabled })).then(onChanged)
            }
          />
          <SettingsValue
            title="Status"
            value={worker.detail || (worker.available ? "Available" : "Unavailable")}
            description={`${worker.version} · ${worker.auth} · ${worker.synced ? "Configuration applied" : "Waiting for configuration"}`}
          />
          <SettingsValue
            title="Account"
            value={
              [worker.account?.email, worker.account?.organization, worker.account?.plan, worker.account?.detail]
                .filter(Boolean)
                .join(" · ") || worker.auth
            }
          />
          <Button
            title="Refresh account"
            busy={resource.busy}
            onPress={() => void resource.run((api) => api.refreshProviders({ ...request, accountOnly: true }))}
          />
          <Button
            title="Sign in"
            busy={resource.busy}
            onPress={() =>
              void resource
                .run((api) => api.startProviderLogin(request))
                .then((r) => {
                  if (r) setLogin(r);
                })
            }
          />
          {login && (
            <>
              <SettingsValue title="Sign-in code" value={login.userCode} />
              <Button title="Open sign-in page" onPress={() => void Linking.openURL(login.verificationUrl)} />
            </>
          )}
          <WorkerOverrides
            key={`${workerId}/${worker.overrides?.$typeName ?? "none"}`}
            instance={instance}
            worker={worker}
            onSaved={() => {
              void resource.reload();
              onChanged();
            }}
          />
        </>
      )}
    </ResourceState>
  );
}

function WorkerOverrides({
  instance,
  worker,
  onSaved,
}: {
  instance: ui.ProviderInstance;
  worker: ui.InstanceOnWorker;
  onSaved: () => void;
}) {
  const resource = useSettingsResource(`overrides:${worker.workerId}/${instance.id}`, (api) =>
    api.getInstanceWorker({ workerId: worker.workerId, harness: instance.harness, id: instance.id }),
  );

  const [binaryPath, setBinary] = useState(worker.overrides?.binaryPath ?? "");
  const [homePath, setHome] = useState(worker.overrides?.homePath ?? "");
  const [shadowHomePath, setShadow] = useState(worker.overrides?.shadowHomePath ?? "");
  const [launchArgs, setArgs] = useState(worker.overrides?.launchArgs.join("\n") ?? "");
  const [argsSet, setArgsSet] = useState(worker.overrides?.launchArgsSet ?? false);
  const [proxyId, setProxy] = useState(worker.overrides?.proxyId ?? "");
  const [baseUrl, setUrl] = useState(worker.overrides?.baseUrl ?? "");
  const [apiKey, setKey] = useState("");
  const [replace, setReplace] = useState(false);
  const [env, setEnv] = useState(environmentDrafts(worker.overrides?.env ?? []));

  async function save(reset = false) {
    const result = await resource.run((api) =>
      api.setInstanceWorker({
        workerId: worker.workerId,
        harness: instance.harness,
        id: instance.id,
        overrides: reset
          ? {}
          : {
              ...(binaryPath && { binaryPath }),
              ...(homePath && { homePath }),
              ...(shadowHomePath && { shadowHomePath }),
              launchArgsSet: argsSet,
              launchArgs: launchArgs.split("\n").filter(Boolean),
              ...(baseUrl && { baseUrl }),
              ...(proxyId && { proxyId }),
              ...(replace && { apiKey }),
              env: environmentInput(env),
            },
      }),
    );

    setKey("");

    if (result) onSaved();
  }

  return (
    <ResourceState resource={resource}>
      <SettingsGroup title="Worker overrides" description="Empty fields use the global definition.">
        <Field
          label="CLI path"
          value={binaryPath}
          onChangeText={setBinary}
          placeholder={instance.runtime?.binaryPath}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Field
          label="CLI home path"
          value={homePath}
          onChangeText={setHome}
          placeholder={instance.runtime?.homePath}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Field
          label="Shadow home path"
          value={shadowHomePath}
          onChangeText={setShadow}
          placeholder={instance.runtime?.shadowHomePath}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <SettingToggle title="Override launch arguments" value={argsSet} onChange={setArgsSet} />
        {argsSet && (
          <Field
            label="Launch arguments · one per line"
            value={launchArgs}
            onChangeText={setArgs}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
        <Field
          label="Proxy ID"
          value={proxyId}
          onChangeText={setProxy}
          placeholder={instance.proxyId}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Field
          label="Base URL"
          value={baseUrl}
          onChangeText={setUrl}
          placeholder={instance.baseUrl}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <SettingToggle title="Replace worker key" value={replace} onChange={setReplace} />
        {replace && (
          <Field
            label="Secret key"
            value={apiKey}
            onChangeText={setKey}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
        <Notice>{worker.overrides?.apiKeySet ? "Worker key set · never returned" : "Uses the definition key"}</Notice>
        <EnvironmentFields value={env} onChange={setEnv} />
        <Button variant="primary" title="Save overrides" busy={resource.busy} onPress={() => void save()} />
        <Button title="Use definition" busy={resource.busy} onPress={() => void save(true)} />
      </SettingsGroup>
    </ResourceState>
  );
}
