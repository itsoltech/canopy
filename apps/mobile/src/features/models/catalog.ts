import { useEffect, useState } from "react";
import { Provider, type ModelInfo, type ProfileModels, type ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useOverview } from "../../state/overview";

/**
 * Model choices of a worker, as the web composers offer them: one section per provider instance turned on and
 * available on the worker (a thread keeps its own instance), with the instance's models from the worker's catalog.
 */
export interface ModelChoice {
  /** `provider:profileId:model`. */
  key: string;
  provider: Provider;
  /** Form value of the instance ("" = the worker's native login). */
  profileId: string;
  model: string;
  name: string;
  efforts: string[];
  defaultEffort: string;
  isDefault: boolean;
  aliases: string[];
}

export interface ModelSection {
  /** `provider:profileId`. */
  key: string;
  title: string;
  provider: Provider;
  profileId: string;
  choices: ModelChoice[];
}

const providers = [Provider.CLAUDE, Provider.CODEX, Provider.GROK];

export const providerName = (provider: Provider) =>
  provider === Provider.CLAUDE
    ? "Claude"
    : provider === Provider.CODEX
      ? "Codex"
      : provider === Provider.GROK
        ? "Grok"
        : "Agent";

const effortLabels = new Map([
  ["none", "None"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
  ["ultra", "Ultra"],
]);

export const effortLabel = (id: string) =>
  effortLabels.get(id) ?? (id ? id[0]!.toUpperCase() + id.slice(1) : "Default");

const instanceLabel = (instance: ui.WorkerInstance) =>
  instance.label || (instance.id === "native" ? "Device login" : instance.id);

const profileValue = (id: string) => (id === "native" ? "" : id);

function choice(provider: Provider, profileId: string, m: ModelInfo): ModelChoice {
  return {
    key: `${provider}:${profileId}:${m.id}`,
    provider,
    profileId,
    model: m.id,
    name: m.displayName || m.id,
    efforts: m.efforts,
    defaultEffort: m.defaultEffort,
    isDefault: m.isDefault,
    aliases: m.aliases,
  };
}

/** `only`: a thread's provider and instance (it keeps both for life, also when turned off there). */
export function modelSections(
  worker: ui.Worker | undefined,
  catalog: ProfileModels[],
  only?: { provider: Provider; profileId: string },
): ModelSection[] {
  const listed = (provider: Provider, profileId: string) =>
    catalog
      .find((p) => p.provider === provider && profileValue(p.profileId) === profileId)
      ?.models.filter((m) => !m.hidden)
      .map((m) => choice(provider, profileId, m)) ?? [];

  if (only) {
    const own = worker?.providerInstances.find(
      (i) => i.harness === only.provider && profileValue(i.id) === only.profileId,
    );

    return [
      {
        key: `${only.provider}:${only.profileId}`,
        title:
          own && only.profileId
            ? `${providerName(only.provider)} · ${instanceLabel(own)}`
            : providerName(only.provider),
        ...only,
        choices: listed(only.provider, only.profileId),
      },
    ];
  }

  return providers.flatMap((provider) => {
    const instances = worker?.providerInstances.filter((i) => i.harness === provider && i.enabled && i.available) ?? [];

    return instances.map((instance) => ({
      key: `${provider}:${profileValue(instance.id)}`,
      title: instances.length > 1 ? `${providerName(provider)} · ${instanceLabel(instance)}` : providerName(provider),
      provider,
      profileId: profileValue(instance.id),
      choices: listed(provider, profileValue(instance.id)),
    }));
  });
}

/** The choice a stored model id names ("" = the instance's default model), matching aliases too. */
export function findChoice(section: ModelSection | undefined, model: string) {
  const choices = section?.choices ?? [];

  if (!model) return choices.find((c) => c.isDefault) ?? choices[0];

  return choices.find((c) => c.model === model || c.aliases.includes(model));
}

/** The worker's model catalog, loaded on selection and again when its home reconnects. */
export function useModelCatalog(workerId: string | undefined) {
  const { client } = useSession();
  const online = useOverview().workers.find((worker) => worker.id === workerId)?.online;
  const [catalog, setCatalog] = useState<{ workerId: string; profiles: ProfileModels[] }>();
  useEffect(() => {
    let active = true;

    if (client && workerId && online)
      void client.api
        .listModels({ workerId })
        .then((r) => {
          if (active) setCatalog({ workerId, profiles: r.workers.flatMap((w) => w.profiles) });
        })
        .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [client, workerId, online]);

  return catalog && catalog.workerId === workerId ? catalog.profiles : [];
}
