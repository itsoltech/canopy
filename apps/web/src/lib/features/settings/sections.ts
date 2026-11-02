import type { IconName } from "#lib/shared/ui/icons.ts";

/** Settings sections with search keywords (the nav filter matches label and keywords). */
export interface SettingsSection {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly group: "General" | "Code" | "Connections";
  readonly keywords: string;
}

export const settingsSections: readonly SettingsSection[] = [
  { href: "/settings/appearance", label: "Appearance", icon: "swatch", group: "General", keywords: "theme color scheme dark light accent chat width" },
  { href: "/settings/threads", label: "Threads", icon: "chat-bubble-left-right", group: "General", keywords: "new thread defaults model profile permissions workspace" },
  { href: "/settings/text-generation", label: "Text generation", icon: "sparkles", group: "General", keywords: "thread title instructions model effort generated text" },
  { href: "/settings/schedules", label: "Scheduled tasks", icon: "clock", group: "General", keywords: "schedule cron recurring repeat wake-up timer automation" },
  { href: "/settings/projects", label: "Projects", icon: "folder", group: "Code", keywords: "project workspace directory threads" },
  { href: "/settings/providers", label: "Providers", icon: "cpu-chip", group: "Connections", keywords: "provider instance codex claude cliproxyapi endpoint key login models favorites environment" },
  { href: "/settings/workers", label: "Workers", icon: "server", group: "Connections", keywords: "worker machine environment device online config" },
];

export const settingsGroups = ["General", "Code", "Connections"] as const;
