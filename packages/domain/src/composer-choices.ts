import { PermissionMode, type ui } from "@canopy/contracts";
import { SPAWN_PERMISSION_MODES } from "./permission-modes.ts";

/** A draft can override one message. Older threads still remember the last user turn's mode. */
export function composerMessagePermission(thread: ui.Thread | undefined, draftMode?: PermissionMode): PermissionMode {
  const previous = thread?.permissionModeSelected ? undefined : thread?.lastUserTurnChoices?.permissionMode;

  return draftMode || previous || PermissionMode.UNSPECIFIED;
}

/** Explicit override for a web Codex message. An unset override inherits the owner’s thread mode at dispatch. */
export function codexMessagePermission(thread: ui.Thread, draftMode?: PermissionMode): PermissionMode {
  if (!thread.permissionModeSelected) return composerMessagePermission(thread, draftMode);

  // An older or transferred draft may still restrict its own message. It cannot broaden the new thread setting.
  if (!draftMode) return PermissionMode.UNSPECIFIED;

  const rank = (mode: PermissionMode) =>
    SPAWN_PERMISSION_MODES.findIndex((key) => key.toUpperCase() === PermissionMode[mode]);

  const threadMode = thread.permissionMode || PermissionMode.ASK;

  return rank(draftMode) <= rank(threadMode) ? draftMode : PermissionMode.UNSPECIFIED;
}

interface ComposerModel {
  model: string;
  aliases?: readonly string[];
  resolvedModel?: string;
  isDefault: boolean;
  efforts: readonly string[];
  defaultEffort?: string;
  serviceTiers?: readonly string[];
}

export interface ComposerPick {
  model?: string;
  effort?: string;
  serviceTier?: string;
  permissionMode?: PermissionMode;
}

/** Both clients restore a thread's own user choices, independently of the loaded history window. */
export function composerChoices<Model extends ComposerModel>(
  thread: ui.Thread | undefined,
  models: readonly Model[],
  pick?: ComposerPick,
) {
  const find = (id: string) =>
    id
      ? models.find((m) => m.model === id || m.resolvedModel === id || m.aliases?.includes(id))
      : (models.find((m) => m.isDefault) ?? models[0]);

  const last = thread?.lastUserTurnChoices;

  const option =
    (pick?.model !== undefined ? find(pick.model) : undefined) ??
    (last ? find(last.model) : undefined) ??
    find(thread?.model ?? "") ??
    find("");

  // An explicit reset uses the thread default; a stored empty effort uses the model default.
  const asked = pick?.effort !== undefined ? pick.effort || thread?.effort : (last?.effort ?? thread?.effort);

  const effort =
    asked && option?.efforts.includes(asked)
      ? asked
      : option?.efforts.includes(option.defaultEffort ?? "")
        ? (option.defaultEffort ?? "")
        : "";

  const permissionOverride = composerMessagePermission(thread, pick?.permissionMode);
  const permissionMode = permissionOverride || thread?.permissionMode || PermissionMode.ASK;
  const askedTier = pick?.serviceTier ?? last?.serviceTier ?? thread?.serviceTier ?? "";
  const serviceTier = askedTier === "default" || option?.serviceTiers?.includes(askedTier) ? askedTier : "";

  return { option, effort, serviceTier, permissionMode, permissionOverride };
}
