import type { ui } from "@canopy/contracts";
import { reflectionModelChoices } from "@canopy/domain/reflection-models";
import { effortLevel, instanceKeyOf, modelKey, modelOption, modelOptions } from "#lib/features/models/catalog.ts";
import { profileIdValue, providerKeyOf } from "#lib/features/threads/providers.ts";

export function habitModelOptions(
  models: readonly ui.MemoryReflectionModel[],
  workers: readonly ui.Worker[],
  catalogs: ReadonlyMap<string, ui.WorkerModels>,
) {
  // The habit snapshot determines eligibility. The shared catalog supplies picker metadata such as favorites and accents.
  const listed = workers.flatMap((worker) => modelOptions({ worker, catalog: catalogs.get(worker.id), threads: [] }));
  const byModel = new Map(listed.map((option) => [option.key, option]));
  const byInstance = new Map(listed.map((option) => [instanceKeyOf(option), option]));

  return reflectionModelChoices(models, workers).flatMap((choice) => {
    const provider = providerKeyOf(choice.provider);

    if (!provider) return [];
    const profileId = profileIdValue(choice.profileId);
    const key = modelKey(provider, profileId, choice.model);

    const base =
      byModel.get(key) ?? modelOption(provider, profileId, choice.profileName, choice.model, undefined, "catalog");

    return [
      {
        ...base,
        profileName: choice.profileName,
        accent: byInstance.get(instanceKeyOf(base))?.accent ?? "",
        name: choice.label === choice.model ? base.name : choice.label,
        efforts: choice.efforts.map(effortLevel),
        defaultEffort: undefined,
      },
    ];
  });
}
