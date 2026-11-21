import type { IconName } from "./icons.ts";

/** Settings sections with labels and aliases shared by navigation and command search. */
export interface SettingsSection {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly group: "General" | "Code" | "Connections";
  readonly keywords: string;
}

export const moduleChoices = [
  { value: "threads", label: "Threads", description: "Run threads and scheduled tasks.", other: "Bots" },
  { value: "bots", label: "Bots", description: "Chat with bots and run routines and reminders.", other: "Threads" },
] as const;

export const moduleSettingsDescription = "Account · Turning off a module stops its work and hides its views.";

/** A project detail URL belongs to the same section as the project list. */
const threadSections = new Set(["threads", "text-generation", "schedules", "projects", "worktrees", "diffs", "import"]);

export function settingsSectionEnabled(path: string, modules: readonly string[]): boolean {
  return modules.includes("threads") || !threadSections.has(path.split("/")[2] ?? "");
}

export function settingsSearchWords(query: string): string[] {
  return query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Match every query word in any order, ignoring case, punctuation and extra spaces. */
export function matchesSettingsSection(section: SettingsSection, query: string): boolean {
  const text = `${section.label} ${section.keywords}`.toLowerCase();

  return settingsSearchWords(query).every((word) => text.includes(word));
}

export const settingsSections: readonly SettingsSection[] = [
  {
    href: "/settings/app-updates",
    label: "App updates",
    icon: "arrow-up",
    group: "General",
    keywords: "app updates stable beta nightly channel version whats new release notes changelog",
  },
  {
    href: "/settings/general",
    label: "General",
    icon: "cog-6-tooth",
    group: "General",
    keywords:
      "modules first tab default order threads bots enable disable notifications sound sidebar grouping projects confirmations unpin archive delete display time zone format",
  },
  {
    href: "/settings/appearance",
    label: "Appearance",
    icon: "swatch",
    group: "General",
    keywords:
      "theme color scheme dark light accent chat width thread width device typography font size interface font interface size monospace font monospace size contrast wrap code blocks wrap diffs effort display context window tokens circle text bar render math latex animated mascots",
  },
  {
    href: "/settings/keybindings",
    label: "Keybindings",
    icon: "command-line",
    group: "General",
    keywords: "keyboard shortcuts hotkeys commands bindings record conflicts",
  },
  {
    href: "/settings/threads",
    label: "Threads",
    icon: "chat-bubble-left-right",
    group: "General",
    keywords:
      "new thread defaults project worker agent model profile permissions workspace archived threads retention auto-delete delete after days cleanup clean up history subagents finished list turn activity while working after turn tool calls reasoning progress expanded collapsed messages steer queue delivery",
  },
  {
    href: "/settings/text-generation",
    label: "Text generation",
    icon: "sparkles",
    group: "General",
    keywords: "thread title instructions model effort generated text",
  },
  {
    href: "/settings/schedules",
    label: "Scheduled tasks",
    icon: "clock",
    group: "General",
    keywords:
      "schedule cron recurring repeat wake-up timer automation time zone timezone preview occurrences end date runs missed message target",
  },
  {
    href: "/settings/diagnostics",
    label: "Diagnostics",
    icon: "signal",
    group: "General",
    keywords:
      "performance health storage disk space logs data cache application database rpc calls network latency rtt history findings computers sync progress remaining records errors failures linked computers",
  },
  {
    href: "/settings/projects",
    label: "Projects",
    icon: "folder",
    group: "Code",
    keywords: "project workspace directory threads",
  },
  {
    href: "/settings/worktrees",
    label: "Worktrees",
    icon: "git-fork",
    group: "Code",
    keywords:
      "git worktree branch base ref remote prefix semantic checkout location creation default workspace cleanup clean up automatic hourly remove delete deleted archived threads merged branches unchanged inactive days keep local changes safe local branches preview run now managed worktrees",
  },
  {
    href: "/settings/providers",
    label: "Providers",
    icon: "cpu-chip",
    group: "Connections",
    keywords: "provider instance codex claude cliproxyapi endpoint key login models favorites environment",
  },
  {
    href: "/settings/diffs",
    label: "Diffs",
    icon: "code-bracket",
    group: "Code",
    keywords: "diff layout side by side stacked whitespace colors wrap collapsed files",
  },
  {
    href: "/settings/agent-environment",
    label: "Agent environment",
    icon: "sparkles",
    group: "Code",
    keywords: "instructions claude.md agents.md fragments skills plugins tags machines sync drift",
  },
  {
    href: "/settings/agent-tools",
    label: "Agent tools",
    icon: "wrench",
    group: "Code",
    keywords: "automation agent browser desktop device simulator emulator worker access install update tools",
  },
  {
    href: "/settings/import",
    label: "Import",
    icon: "arrow-down-tray",
    group: "Code",
    keywords: "import claude code codex grok cli sessions history resume migrate",
  },
  {
    href: "/settings/github",
    label: "GitHub",
    icon: "link",
    group: "Connections",
    keywords: "github account device code app installations repositories personal access token",
  },
  {
    href: "/settings/connectors",
    label: "Connectors",
    icon: "link",
    group: "Connections",
    keywords:
      "github slack outlook microsoft notion linear google atlassian custom mcp server oauth accounts integrations access authentication endpoint url token secret headers client secret scopes",
  },
  {
    href: "/settings/proxies",
    label: "Proxies",
    icon: "link",
    group: "Connections",
    keywords: "proxy cliproxyapi anthropic openai endpoint secret key connection",
  },
  {
    href: "/settings/workers",
    label: "Workers",
    icon: "server",
    group: "Connections",
    keywords: "worker machine environment device online config",
  },
  {
    href: "/settings/network",
    label: "Network access",
    icon: "signal",
    group: "Connections",
    keywords: "network listen port address hostname tailscale lan wifi firewall phones computers connect",
  },
  {
    href: "/settings/mobile",
    label: "Devices",
    icon: "link",
    group: "Connections",
    keywords:
      "phone iphone android pairing qr tailscale device revoke unpair this phone forget pairing locally mobile desktop app",
  },
  {
    href: "/settings/computers",
    label: "Linked computers",
    icon: "server",
    group: "Connections",
    keywords: "computer link pair fingerprint certificate network desktop",
  },
];

export const settingsGroups = ["General", "Code", "Connections"] as const;

/** Gateway methods used to show these sections in web and desktop navigation. */
export const settingsSectionMethods = {
  "/settings/providers": ["ListProviderInstances", "SaveProviderInstance"],
  "/settings/connectors": ["ListConnectors", "SaveConnectorAccount"],
  "/settings/github": ["ListGitHubAccounts", "BeginGitHubDeviceAuth"],
  "/settings/workers": ["GetWorkerSetup", "CreateWorkerEnrollment"],
  "/settings/agent-tools": ["SetAgentToolEnabled", "InstallAgentTool", "RefreshAgentTools"],
  "/settings/network": ["GetNetworkAccess", "UpdateNetworkAccess"],
  "/settings/mobile": ["GetMobileDevices", "CreateDesktopPairing"],
  "/settings/computers": ["GetComputers", "ManageComputer"],
  "/settings/schedules": ["ListSchedules", "CreateSchedule"],
  "/settings/projects": ["GetOverview", "CreateProject"],
  "/settings/import": ["ScanImport", "ListImportCandidates"],
};

/** Settings sections supplied by the desktop client itself. */
export const desktopSettingsSections: readonly SettingsSection[] = [
  {
    href: "/settings/desktop",
    label: "Desktop",
    icon: "server",
    group: "Connections",
    keywords: "desktop local remote worker computer",
  },
];
