import { create } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ui } from "@open-agents/contracts";

/**
 * Starting values of a new thread: the project's defaults over the user's. The agent (provider,
 * profile, model) is one unit: a project that names a provider brings its own profile and model, so a
 * Claude project never inherits a Codex-only profile. Workspace and permissions override one by one.
 * Empty fields mean "no preference".
 */
export function effectiveDefaults(user: ui.ThreadDefaults, project: ui.ThreadDefaults | undefined): ui.ThreadDefaults {
  if (!project) return user;
  const agent = project.provider !== Provider.UNSPECIFIED ? project : user;
  return create(ui.ThreadDefaultsSchema, {
    workspaceId: project.workspaceId || user.workspaceId,
    provider: agent.provider,
    providerProfileId: agent.providerProfileId,
    model: agent.model,
    permissionMode: project.permissionMode !== PermissionMode.UNSPECIFIED ? project.permissionMode : user.permissionMode,
  });
}
