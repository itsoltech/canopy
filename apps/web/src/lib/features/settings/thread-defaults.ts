import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";

export { effectiveThreadDefaults as effectiveDefaults } from "@canopy/domain/new-thread-choices";

/** The default model of a provider ("" = the profile's default). */
export function modelFor(defaults: ui.ThreadDefaults, provider: Provider): string {
  return defaults.models.find((m) => m.provider === provider)?.model ?? "";
}

/** Defaults' models with one provider's model set (empty removes it). */
export function withModel(models: readonly ui.ProviderModel[], provider: Provider, model: string): ui.ProviderModel[] {
  const others = models.filter((m) => m.provider !== provider);

  return model ? [...others, create(ui.ProviderModelSchema, { provider, model })] : others;
}
