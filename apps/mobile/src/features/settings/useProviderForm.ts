import { useState } from "react";
import { Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
import { useSettingsResource } from "./resource";
import { providerSettingsError } from "./provider-settings-error";
import { useProviderSettingsDraft } from "./useProviderSettingsDraft";
import { environmentDrafts, environmentInput, environmentProblems } from "./EnvironmentFields";

export function useProviderForm({
  instance,
  harness,
  initialWorkerId = "",
  onSaved,
}: {
  instance?: ui.ProviderInstance;
  harness: Provider;
  initialWorkerId?: string;
  onSaved: (instance?: ui.ProviderInstance) => void;
}) {
  const resource = useSettingsResource(
    "ListWorkerRecords",
    (api) => api.listWorkerRecords({}),
    true,
    providerSettingsError,
  );

  const [customId, setId] = useState<string>();

  const [label, setLabel] = useState(instance?.label ?? "");

  const id =
    instance?.id ??
    customId ??
    label
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+|-+$/g, "")
      .slice(0, 40);

  const [accentColor, setAccent] = useState(instance?.accentColor ?? "");
  const [kind, setKind] = useState(instance?.kind ?? ProviderProfileKind.CLIPROXYAPI);
  const [proxyId, setProxy] = useState(instance?.proxyId ?? "");
  const settings = useProviderSettingsDraft(harness, instance?.runtime?.settingsText);

  const [runtime, setRuntime] = useState({
    binaryPath: instance?.runtime?.binaryPath ?? "",
    homePath: instance?.runtime?.homePath ?? "",
    shadowHomePath: instance?.runtime?.shadowHomePath ?? "",
    launchArgs: instance?.runtime?.launchArgs.join("\n") ?? "",
    ownLogin: instance?.runtime?.ownLogin ?? false,
    userConfiguration: instance?.runtime?.userConfiguration,
  });

  const [env, setEnv] = useState(environmentDrafts(instance?.env ?? []));
  const [allWorkers, setAll] = useState(instance?.allWorkers ?? !initialWorkerId);

  const [workerIds, setWorkers] = useState(
    instance?.workers.filter((w) => w.enabled).map((w) => w.workerId) ?? (initialWorkerId ? [initialWorkerId] : []),
  );

  const validId = id !== "native" && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(id);

  const problems = environmentProblems(kind, env);

  const ready =
    !settings.saveBlocked &&
    !problems.size &&
    (!!label.trim() || instance?.builtIn) &&
    (!!instance || (validId && (allWorkers || workerIds.length > 0))) &&
    (kind !== ProviderProfileKind.CLIPROXYAPI || !!proxyId);

  async function save() {
    if (!settings.canSave()) return;

    const result = await resource.run((api) =>
      api.saveProviderInstance({
        harness,
        id,
        create: !instance,
        label,
        accentColor,
        kind,
        proxyId: kind === ProviderProfileKind.CLIPROXYAPI ? proxyId : "",
        env: environmentInput(env),
        runtime: {
          ...runtime,
          launchArgs: runtime.launchArgs.split("\n").filter(Boolean),
          settingsText: settings.settingsText,
        },
        expectedRevision: instance?.revision ?? 0n,
        // Editing: where it runs is chosen in the Status section and saved there.
        ...(!instance && { allWorkers, workerIds: allWorkers ? [] : workerIds }),
      }),
    );

    if (result) {
      setEnv(environmentDrafts(instance?.env ?? []));
      onSaved(result.instance);
    }
  }

  return {
    resource,
    id,
    setId,
    label,
    setLabel,
    accentColor,
    setAccent,
    kind,
    setKind,
    proxyId,
    setProxy,
    runtime,
    setRuntime,
    settings,
    env,
    setEnv,
    allWorkers,
    setAll,
    workerIds,
    setWorkers,
    save,
    validId,
    problems,
    ready,
  };
}
