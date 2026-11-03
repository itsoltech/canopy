import { create } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ui } from "@canopy/contracts";

/**
 * Starting values of a new thread: the project's defaults over the user's. The agent (provider,
 * profile, model) is one unit: a project that names a provider brings its own profile and model, so a
 * Claude project never inherits a Codex-only profile. Models are kept per provider, so switching the agent
 * in a new thread keeps what each one was set to. Workspace and permissions override one by one.
 * Empty fields mean "no preference".
 */
export function effectiveDefaults(user: ui.ThreadDefaults, project: ui.ThreadDefaults | undefined): ui.ThreadDefaults {
  if (!project) return user;
  const agent = project.provider !== Provider.UNSPECIFIED ? project : user;
  return create(ui.ThreadDefaultsSchema, {
    workspaceId: project.workspaceId || user.workspaceId,
    provider: agent.provider,
    providerProfileId: agent.providerProfileId,
    models: agent.models,
    permissionMode: project.permissionMode !== PermissionMode.UNSPECIFIED ? project.permissionMode : user.permissionMode,
  });
}

/** The default model of a provider ("" = the profile's default). */
export function modelFor(defaults: ui.ThreadDefaults, provider: Provider): string {
  return defaults.models.find((m) => m.provider === provider)?.model ?? "";
}

/** Defaults' models with one provider's model set (empty removes it). */
export function withModel(models: readonly ui.ProviderModel[], provider: Provider, model: string): ui.ProviderModel[] {
  const others = models.filter((m) => m.provider !== provider);
  return model ? [...others, create(ui.ProviderModelSchema, { provider, model })] : others;
}
