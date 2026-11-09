import { PermissionMode, type ui } from "@canopy/contracts";

interface ComposerModel {
  model: string;
  aliases?: readonly string[];
  resolvedModel?: string;
  isDefault: boolean;
  efforts: readonly string[];
  defaultEffort?: string;
}

export interface ComposerPick {
  model?: string;
  effort?: string;
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

  const permissionMode = pick?.permissionMode ?? last?.permissionMode ?? thread?.permissionMode ?? PermissionMode.ASK;

  return { option, effort, permissionMode };
}
