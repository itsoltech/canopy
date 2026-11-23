import type { Provider, ui } from "@canopy/contracts";

export interface ReflectionModelChoice {
  provider: Provider;
  profileId: string;
  profileName: string;
  model: string;
  label: string;
  efforts: string[];
}

const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const ranks = new Map(effortOrder.map((effort, index) => [effort, index]));

/** A choice can run on any worker offering that profile, model and effort together. */
export function reflectionModelChoices(models: readonly ui.MemoryReflectionModel[], workers: readonly ui.Worker[]) {
  const profileNames = new Map<string, string>();

  for (const worker of workers) {
    if (worker.nodeId) continue;

    for (const instance of worker.providerInstances) {
      if (instance.label) profileNames.set(`${instance.harness}:${instance.id}`, instance.label);
    }
  }

  const choices = new Map<string, ReflectionModelChoice>();

  for (const row of models) {
    const profileId = row.profileId || "native";
    const profile = `${row.provider}:${profileId}`;
    const profileName = profileNames.get(profile) || (profileId === "native" ? "Device login" : profileId);
    const base = { provider: row.provider, profileId, profileName };

    if (!choices.has(profile)) choices.set(profile, { ...base, model: "", label: "Auto", efforts: [] });

    if (!row.model) continue;
    const key = `${profile}:${row.model}`;
    const choice = choices.get(key);

    if (choice) {
      choice.efforts = [...new Set([...choice.efforts, ...row.efforts])];
    } else {
      choices.set(key, { ...base, model: row.model, label: row.label || row.model, efforts: [...row.efforts] });
    }
  }

  for (const choice of choices.values()) {
    choice.efforts.sort((a, b) => (ranks.get(a) ?? effortOrder.length) - (ranks.get(b) ?? effortOrder.length));
  }

  return [...choices.values()];
}

/** Older gateways require one worker shared by every project. Choose it for the client when that is possible. */
export function reflectionWorkerForSave(
  snapshot: ui.MemoryHabitsSnapshot,
  draft: ui.MemoryReflectionSettings,
  projects: readonly ui.Project[],
): string | undefined {
  if (snapshot.automaticWorkerSelection || !draft.provider) return "";

  const saved = snapshot.settings;

  if (
    !draft.enabled &&
    saved?.workerId &&
    saved.provider === draft.provider &&
    saved.profileId === draft.profileId &&
    saved.model === draft.model &&
    saved.effort === draft.effort
  )
    return saved.workerId;

  const workspaces = draft.projectIds.map((id) => projects.find((p) => !p.nodeId && p.id === id)?.workspaces);

  const supports = (row: ui.MemoryReflectionModel) =>
    row.provider === draft.provider &&
    row.profileId === draft.profileId &&
    (!draft.model || row.model === draft.model) &&
    (!draft.effort || row.efforts.includes(draft.effort)) &&
    workspaces.every((ws) => ws?.some(({ workerId }) => workerId === row.workerId));

  const candidates = snapshot.models.filter(supports);

  return candidates.find(({ workerId }) => workerId === saved?.workerId)?.workerId ?? candidates[0]?.workerId;
}

export const reflectionGatewayUpdate = "Update the gateway to use this model across the selected projects.";
