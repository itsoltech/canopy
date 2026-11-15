import { create } from "@bufbuild/protobuf";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import { PermissionMode, Provider, ui } from "@canopy/contracts";

/** Resolve the agent as one choice; workspace and permissions inherit independently. */
export function effectiveThreadDefaults(
  user: ui.ThreadDefaults | undefined,
  project?: ui.ThreadDefaults,
): ui.ThreadDefaults {
  const fixedProject =
    !!project &&
    project.useLastAgent !== true &&
    (project.provider !== Provider.UNSPECIFIED || project.useLastAgent === false);

  const defaults = user ?? create(ui.ThreadDefaultsSchema);
  const agent = fixedProject ? project : defaults;

  return create(ui.ThreadDefaultsSchema, {
    workspaceId: project?.workspaceId || defaults.workspaceId,
    provider: agent.provider,
    providerProfileId: agent.providerProfileId,
    models: agent.models,
    useLastAgent:
      project?.useLastAgent === true
        ? true
        : fixedProject
          ? false
          : (defaults.useLastAgent ?? defaults.provider === Provider.UNSPECIFIED),
    permissionMode:
      project && project.permissionMode !== PermissionMode.UNSPECIFIED
        ? project.permissionMode
        : defaults.permissionMode,
    subagentPermissionMode: defaults.subagentPermissionMode,
  });
}

const time = (at: Timestamp | undefined) => (at?.seconds ?? 0n) * 1_000_000_000n + BigInt(at?.nanos ?? 0);

/** Compare the last eligible user turn, independently of list order and later agent activity. */
export function latestThreadChoices(threads: Iterable<ui.Thread>): ui.Thread | undefined {
  let latest: ui.Thread | undefined;
  let latestAt = 0n;

  for (const thread of threads) {
    if (thread.deletedAt || !thread.lastUserTurnChoices) continue;
    const at = time(thread.lastUserTurnChoices.createdAt ?? thread.lastActivityAt ?? thread.createdAt);

    if (!latest || at > latestAt || (at === latestAt && thread.id > latest.id)) {
      latest = thread;
      latestAt = at;
    }
  }

  return latest;
}
