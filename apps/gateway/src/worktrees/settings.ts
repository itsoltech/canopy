import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { WorktreeScopeRow } from "../store/worktrees.ts";

/** Built-in values under every scope (docs/worktrees.md, "Ustawienia i zakresy"). */
export const WORKTREE_DEFAULTS = create(ui.WorktreeSettingsSchema, {
  location: "",
  startFromRemote: false,
  remote: "origin",
  branchNaming: ui.BranchNaming.SEMANTIC,
  branchPrefix: "canopy",
  defaultMode: ui.WorkspaceMode.CHECKOUT,
  cleanupDeletedThreads: false,
  cleanupMerged: false,
  cleanupInactiveDays: 0,
  cleanupSettled: false,
  cleanupUnchanged: false,
  keepLocalChanges: true,
  deleteLocalBranch: false,
});

const FIELDS = [
  "location",
  "startFromRemote",
  "remote",
  "branchNaming",
  "branchPrefix",
  "defaultMode",
  "cleanupDeletedThreads",
  "cleanupMerged",
  "cleanupInactiveDays",
  "cleanupSettled",
  "cleanupUnchanged",
  "keepLocalChanges",
  "deleteLocalBranch",
] as const;

function overrides(settings: ui.WorktreeSettings, field: (typeof FIELDS)[number]): boolean {
  return field === "branchNaming" || field === "defaultMode" ? Boolean(settings[field]) : settings[field] !== undefined;
}

/** A scope's stored overrides, read leniently (fields dropped from the contract are ignored). */
export function storedSettings(json: JsonValue): ui.WorktreeSettings {
  return fromJson(ui.WorktreeSettingsSchema, json, { ignoreUnknownFields: true });
}

export function settingsJson(settings: ui.WorktreeSettings): JsonValue {
  return toJson(ui.WorktreeSettingsSchema, settings);
}

/** `over` on top of `base`: set optional fields and specified enums win. */
export function mergeSettings(base: ui.WorktreeSettings, over: ui.WorktreeSettings): ui.WorktreeSettings {
  return create(ui.WorktreeSettingsSchema, {
    location: over.location ?? base.location,
    startFromRemote: over.startFromRemote ?? base.startFromRemote,
    remote: over.remote ?? base.remote,
    branchNaming: over.branchNaming || base.branchNaming,
    branchPrefix: over.branchPrefix ?? base.branchPrefix,
    defaultMode: over.defaultMode || base.defaultMode,
    cleanupDeletedThreads: over.cleanupDeletedThreads ?? base.cleanupDeletedThreads,
    cleanupMerged: over.cleanupMerged ?? base.cleanupMerged,
    cleanupInactiveDays: over.cleanupInactiveDays ?? base.cleanupInactiveDays,
    cleanupSettled: over.cleanupSettled ?? base.cleanupSettled,
    cleanupUnchanged: over.cleanupUnchanged ?? base.cleanupUnchanged,
    keepLocalChanges: over.keepLocalChanges ?? base.keepLocalChanges,
    deleteLocalBranch: over.deleteLocalBranch ?? base.deleteLocalBranch,
  });
}

/** Branch prefixes and remote names: what git accepts in a ref component, kept short. */
const REF_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** Why the overrides cannot be saved, or undefined. */
export function settingsProblem(settings: ui.WorktreeSettings, isAbsolute: (path: string) => boolean) {
  if (
    settings.cleanupInactiveDays !== undefined &&
    (!Number.isInteger(settings.cleanupInactiveDays) || settings.cleanupInactiveDays > 3650)
  )
    return "inactive days must be between 0 and 3650";

  if (
    settings.location &&
    (settings.location.includes("\0") || settings.location.length > 1024 || !isAbsolute(settings.location))
  )
    return "the worktree location must be an absolute path";

  if (
    settings.branchPrefix !== undefined &&
    (!REF_PART.test(settings.branchPrefix) ||
      settings.branchPrefix.includes("..") ||
      settings.branchPrefix.endsWith(".") ||
      settings.branchPrefix.endsWith(".lock"))
  )
    return "the branch prefix may use letters, digits, '.', '_' and '-'";

  if (settings.remote !== undefined && !REF_PART.test(settings.remote)) return "unknown remote name";

  if (
    ![ui.BranchNaming.UNSPECIFIED, ui.BranchNaming.SEMANTIC, ui.BranchNaming.PREFIX, ui.BranchNaming.TITLE].includes(
      settings.branchNaming,
    )
  )
    return "unknown branch naming mode";

  if (
    ![ui.WorkspaceMode.UNSPECIFIED, ui.WorkspaceMode.CHECKOUT, ui.WorkspaceMode.NEW_WORKTREE].includes(
      settings.defaultMode,
    )
  )
    return "choose current checkout or new worktree as the default workspace";

  return undefined;
}

export interface ResolvedScope {
  /** This scope's own overrides. */
  readonly own: ui.WorktreeSettings;
  /** Defaults and the broader scopes. */
  readonly inherited: ui.WorktreeSettings;
  readonly effective: ui.WorktreeSettings;
  readonly version: bigint;
  readonly inheritedSources: ui.WorktreeSettingSource[];
}

/** Merges the rows that apply to a scope (broadest first, as the store returns them). */
export function resolveScope(
  rows: readonly WorktreeScopeRow[],
  projectId: string | null,
  workerId: string | null,
): ResolvedScope {
  const isOwn = (r: WorktreeScopeRow) => r.project_id === projectId && r.worker_id === workerId;
  const ownRow = rows.find(isOwn);
  const own = ownRow ? storedSettings(ownRow.settings) : create(ui.WorktreeSettingsSchema);

  const inherited = rows
    .filter((r) => !isOwn(r))
    .reduce((acc, r) => mergeSettings(acc, storedSettings(r.settings)), WORKTREE_DEFAULTS);

  const inheritedSources = FIELDS.flatMap((field) => {
    const row = rows.findLast((r) => !isOwn(r) && overrides(storedSettings(r.settings), field));

    return row
      ? [
          create(ui.WorktreeSettingSourceSchema, {
            field,
            projectId: row.project_id ?? "",
            workerId: row.worker_id ?? "",
          }),
        ]
      : [];
  });

  return {
    own,
    inherited,
    effective: mergeSettings(inherited, own),
    version: ownRow ? BigInt(ownRow.version) : 0n,
    inheritedSources,
  };
}
