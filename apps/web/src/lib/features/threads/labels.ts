import { PermissionMode, Provider } from "@canopy/contracts";
import type { IconName } from "#lib/shared/ui/icons.ts";

export const providerLabel = (provider: Provider): string =>
  provider === Provider.CLAUDE
    ? "Claude"
    : provider === Provider.CODEX
      ? "Codex"
      : provider === Provider.GROK
        ? "Grok"
        : "Agent";

/** Permission modes offered when creating a thread (value = enum key, sent to the form action). */
export const permissionModes = [
  { value: "ASK", label: "Ask first", description: "Asks before writing files or running commands." },
  {
    value: "ACCEPT_EDITS",
    label: "Accept edits",
    description: "Edits files in the workspace, asks for everything else.",
  },
  { value: "READ_ONLY", label: "Read only", description: "Reads files, never changes them." },
  { value: "FULL_AUTO", label: "Full auto", description: "Runs without asking, sandboxed to the workspace." },
  { value: "FULL_ACCESS", label: "Full access", description: "Runs without asking and without a sandbox." },
] as const satisfies readonly { value: keyof typeof PermissionMode; label: string; description: string }[];

export type PermissionModeKey = (typeof permissionModes)[number]["value"];

/** A PermissionMode enum name ("ASK", "UNSPECIFIED"); not the enum's numeric reverse mapping or other keys. */
export const isPermissionModeName = (name: string): name is keyof typeof PermissionMode =>
  Object.hasOwn(PermissionMode, name) && !/^\d+$/.test(name);

/** The mode's key; unspecified (and unknown) = ASK, as the worker treats it. */
export function permissionKey(mode: PermissionMode): PermissionModeKey {
  return permissionModes.find((m) => PermissionMode[m.value] === mode)?.value ?? "ASK";
}

const isModeKey = (mode: PermissionMode | PermissionModeKey): mode is PermissionModeKey => typeof mode === "string";

export function permissionLabel(mode: PermissionMode | PermissionModeKey): string {
  const key = isModeKey(mode) ? mode : permissionKey(mode);

  return permissionModes.find((m) => m.value === key)?.label ?? "Ask first";
}

/** FULL_AUTO runs without asking: shown with a warning wherever it is chosen or shown. */
export const isFullAuto = (mode: PermissionMode | PermissionModeKey): boolean =>
  mode === "FULL_AUTO" || mode === PermissionMode.FULL_AUTO;

/** FULL_ACCESS runs without asking and without a sandbox: rose, and confirmed each time it is picked. */
export const isFullAccess = (mode: PermissionMode | PermissionModeKey): boolean =>
  mode === "FULL_ACCESS" || mode === PermissionMode.FULL_ACCESS;

/** A mode that never asks (Full auto, Full access): shown with its tone wherever it is chosen or shown. */
export const isUnprompted = (mode: PermissionMode | PermissionModeKey): boolean =>
  isFullAuto(mode) || isFullAccess(mode);

/** A mode a new draft takes over from another thread: Full access is never inherited, it is picked again. */
export const inheritedMode = (mode: PermissionModeKey): PermissionModeKey =>
  mode === "FULL_ACCESS" ? "FULL_AUTO" : mode;

export interface PermissionLook {
  icon: IconName;
  tone: "neutral" | "amber" | "rose";
  /** The quiet tag next to the name in lists of choices. */
  badge?: string;
  iconClass: string;
  textClass: string;
}

/**
 * How a mode is shown (pills, panel, turn footer): full auto gets a warning shield and amber text, full access
 * a crossed-out shield and rose text.
 */
export function permissionLook(mode: PermissionMode | PermissionModeKey): PermissionLook {
  if (isFullAccess(mode))
    return {
      icon: "shield-off",
      tone: "rose",
      badge: "No sandbox",
      iconClass: "text-rose-600 dark:text-rose-400",
      textClass: "text-rose-700 dark:text-rose-400",
    };

  return isFullAuto(mode)
    ? {
        icon: "shield-exclamation",
        tone: "amber",
        badge: "No prompts",
        iconClass: "text-amber-600 dark:text-amber-400",
        textClass: "text-amber-700 dark:text-amber-400",
      }
    : {
        icon: "shield-check",
        tone: "neutral",
        iconClass: "fill-zinc-400 dark:fill-zinc-500",
        textClass: "text-zinc-500 dark:text-zinc-400",
      };
}
