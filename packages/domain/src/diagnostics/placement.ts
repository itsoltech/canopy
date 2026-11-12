import { Provider, type ProfileModels, type ui } from "@canopy/contracts";

/** The same existing local placement and provider-instance choices on every client. */
export function investigationChoices(worker: ui.Worker | undefined, catalog: readonly ProfileModels[]) {
  return (worker?.providerInstances ?? [])
    .filter((instance) => instance.enabled && instance.available)
    .flatMap((instance) => {
      const profileId = instance.id === "native" ? "" : instance.id;
      const provider = instance.harness;
      const name = provider === Provider.CLAUDE ? "Claude" : provider === Provider.CODEX ? "Codex" : "Grok";

      const models =
        catalog
          .find(
            (profile) =>
              profile.provider === provider && (profile.profileId === "native" ? "" : profile.profileId) === profileId,
          )
          ?.models.filter((model) => !model.hidden) ?? [];

      return [
        {
          value: `${provider}:${profileId}:`,
          label: `${name} · ${instance.label || instance.id} · Default model`,
          provider,
          profileId,
          model: "",
        },
        ...models.map((model) => ({
          value: `${provider}:${profileId}:${model.id}`,
          label: `${name} · ${instance.label || instance.id} · ${model.displayName || model.id}`,
          provider,
          profileId,
          model: model.id,
        })),
      ];
    });
}
