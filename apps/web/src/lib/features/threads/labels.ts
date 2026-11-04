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
] as const satisfies readonly { value: keyof typeof PermissionMode; label: string; description: string }[];

export type PermissionModeKey = (typeof permissionModes)[number]["value"];

/** The mode's key; unspecified (and unknown) = ASK, as the worker treats it. */
export function permissionKey(mode: PermissionMode): PermissionModeKey {
  return permissionModes.find((m) => PermissionMode[m.value] === mode)?.value ?? "ASK";
}

export function permissionLabel(mode: PermissionMode | PermissionModeKey): string {
  const key = typeof mode === "string" ? mode : permissionKey(mode);

  return permissionModes.find((m) => m.value === key)?.label ?? "Ask first";
}

/** FULL_AUTO runs without asking: shown with a warning wherever it is chosen or shown. */
export const isFullAuto = (mode: PermissionMode | PermissionModeKey): boolean =>
  mode === "FULL_AUTO" || mode === PermissionMode.FULL_AUTO;

/** How a mode is shown (pills, panel, turn footer): full auto gets a warning shield and amber text. */
export function permissionLook(mode: PermissionMode | PermissionModeKey): {
  icon: IconName;
  iconClass: string;
  textClass: string;
} {
  return isFullAuto(mode)
    ? {
        icon: "shield-exclamation",
        iconClass: "fill-amber-600 dark:fill-amber-400",
        textClass: "text-amber-700 dark:text-amber-400",
      }
    : {
        icon: "shield-check",
        iconClass: "fill-zinc-400 dark:fill-zinc-500",
        textClass: "text-zinc-500 dark:text-zinc-400",
      };
}
