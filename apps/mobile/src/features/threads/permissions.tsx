import { Alert } from "react-native";
import { PermissionMode } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";
import { PickerSheet } from "../../ui/Picker";

/** Permission modes as the web composers offer them (labels and descriptions match apps/web threads/labels.ts). */
export const permissionModes = [
  { mode: PermissionMode.ASK, label: "Ask first", description: "Asks before writing files or running commands." },
  {
    mode: PermissionMode.ACCEPT_EDITS,
    label: "Accept edits",
    description: "Edits files in the workspace, asks for everything else.",
  },
  { mode: PermissionMode.READ_ONLY, label: "Read only", description: "Reads files, never changes them." },
  {
    mode: PermissionMode.FULL_AUTO,
    label: "Full auto",
    description: "Runs without asking, sandboxed to the workspace.",
  },
  { mode: PermissionMode.FULL_ACCESS, label: "Full access", description: "Runs without asking and without a sandbox." },
] as const;

export const permissionLabel = (mode: PermissionMode | undefined) =>
  permissionModes.find((m) => m.mode === mode)?.label ?? "Ask first";

/** Full auto: amber with a warning shield. Full access has no sandbox either: rose with a crossed-out shield. */
export interface PermissionLook {
  icon: IconName;
  tone?: "warning" | "danger";
  /** The quiet tag next to the name in lists of choices. */
  badge?: string;
}

export function permissionLook(mode: PermissionMode | undefined): PermissionLook {
  if (mode === PermissionMode.FULL_ACCESS) return { icon: "shield-off", tone: "danger", badge: "No sandbox" };

  if (mode === PermissionMode.FULL_AUTO) return { icon: "shield-exclamation", tone: "warning", badge: "No prompts" };

  return { icon: "shield-check" };
}

/** Shared confirmation for owner-selected thread, bot and subagent settings. */
export function pickPermission(
  mode: PermissionMode,
  current: PermissionMode,
  onSelect: (mode: PermissionMode) => void,
) {
  if (mode !== PermissionMode.FULL_ACCESS || mode === current) return onSelect(mode);
  Alert.alert(
    "Turn on full access?",
    "The agent edits files and runs commands without asking. No sandbox keeps it in the workspace. It can change any file this computer’s worker can reach and use the network.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Turn on full access", style: "destructive", onPress: () => onSelect(mode) },
    ],
  );
}

/** Picks a mode; Full access is confirmed each time it is picked. */
export function PermissionPickerSheet({
  visible,
  onClose,
  value,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  value: PermissionMode | undefined;
  onSelect: (mode: PermissionMode) => void;
}) {
  const current = value === PermissionMode.UNSPECIFIED || value === undefined ? PermissionMode.ASK : value;

  function pick(mode: PermissionMode) {
    pickPermission(mode, current, onSelect);
  }

  return (
    <PickerSheet
      title="Permissions"
      visible={visible}
      onClose={onClose}
      value={current}
      onSelect={pick}
      sections={[
        {
          options: permissionModes.map((m) => ({
            value: m.mode,
            label: m.label,
            description: m.description,
            ...permissionLook(m.mode),
          })),
        },
      ]}
    />
  );
}
