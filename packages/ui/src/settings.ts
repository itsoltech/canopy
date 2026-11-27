import type { IconName } from "./icons.ts";

export const settingsGroups = ["Preferences", "Workspace", "Agents", "Connections", "System"] as const;

/** Settings sections with labels and aliases shared by navigation and command search. */
export interface SettingsSection {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly group: (typeof settingsGroups)[number];
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
    href: "/settings/general",
    label: "General",
    icon: "cog-6-tooth",
    group: "Preferences",
    keywords:
      "modules first tab default order threads bots enable disable display time zone format device quit shortcut",
  },
  {
    href: "/settings/appearance",
    label: "Appearance",
    icon: "swatch",
    group: "Preferences",
    keywords:
      "theme color scheme dark light accent chat width thread width device typography font size interface font interface size monospace font monospace size contrast wrap code blocks wrap diffs effort display context window tokens circle text bar render math latex animated mascots themes theme builder custom palette corner radius rounding rounded spacing density compact spacious",
  },
  {
    href: "/settings/notifications",
    label: "Notifications",
    icon: "bell",
    group: "Preferences",
    keywords:
      "notifications alerts thread bot chats messages habit suggestions in-app system sound silent desktop activity notch push phone claude usage limit resets",
  },
  {
    href: "/settings/keybindings",
    label: "Keybindings",
    icon: "keyboard",
    group: "Preferences",
    keywords: "keyboard shortcuts hotkeys commands bindings record conflicts",
  },
  {
    href: "/settings/threads",
    label: "Threads",
    icon: "chat-bubble-left-right",
    group: "Workspace",
    keywords:
      "new thread defaults project worker agent model profile permissions workspace worktree sidebar thread list grouping group by project order working section position confirmations confirm unpin archive delete archived threads retention auto-delete delete after days cleanup clean up history subagents finished list turn activity while working after turn tool calls reasoning progress expanded collapsed messages steer queue delivery conversation sandbox and subagents archiving notify agent pull requests",
  },
  {
    href: "/settings/projects",
    label: "Projects",
    icon: "folder",
    group: "Workspace",
    keywords:
      "project workspace directory threads workspaces project details secrets api keys tokens thread defaults notify agent pull requests",
  },
  {
    href: "/settings/worktrees",
    label: "Worktrees",
    icon: "git-fork",
    group: "Workspace",
    keywords:
      "git worktree branch base ref remote prefix semantic checkout location creation default workspace cleanup clean up automatic hourly remove delete deleted archived threads merged branches unchanged inactive days keep local changes safe local branches preview run now managed worktrees new worktrees cleanup rules",
  },
  {
    href: "/settings/diffs",
    label: "Diffs",
    icon: "code-bracket",
    group: "Workspace",
    keywords: "diff layout side by side stacked whitespace colors wrap collapsed files",
  },
  {
    href: "/settings/schedules",
    label: "Scheduled tasks",
    icon: "clock",
    group: "Workspace",
    keywords:
      "schedule cron recurring repeat wake-up timer automation time zone timezone preview occurrences end date runs missed message target",
  },
  {
    href: "/settings/import",
    label: "Import",
    icon: "arrow-down-tray",
    group: "Workspace",
    keywords: "import claude code codex grok cli sessions history resume migrate new import activity",
  },
  {
    href: "/settings/providers",
    label: "Providers",
    icon: "cpu-chip",
    group: "Agents",
    keywords:
      "provider instance codex claude cliproxyapi endpoint key login models favorites environment status and access configuration worker overrides",
  },
  {
    href: "/settings/agent-environment",
    label: "Agent environment",
    icon: "folder-open",
    group: "Agents",
    keywords: "instructions claude.md agents.md fragments skills plugins tags machines sync drift computers",
  },
  {
    href: "/settings/agent-tools",
    label: "Agent tools",
    icon: "wrench",
    group: "Agents",
    keywords:
      "automation agent browser desktop device simulator emulator worker access install update tools session defaults",
  },
  {
    href: "/settings/memory",
    label: "Memory",
    icon: "square-2-stack",
    group: "Agents",
    keywords: "agent bot memory notes aliases pinned project worker conversation scope edit delete habits reflection",
  },
  {
    href: "/settings/text-generation",
    label: "Text generation",
    icon: "sparkles",
    group: "Agents",
    keywords: "thread title instructions model effort generated text",
  },
  {
    href: "/settings/connectors",
    label: "Connectors",
    icon: "plug",
    group: "Connections",
    keywords:
      "github slack outlook microsoft notion linear google atlassian custom mcp server oauth accounts integrations access authentication endpoint url token secret headers client secret scopes tool accounts slack bots",
  },
  {
    href: "/settings/github",
    label: "GitHub",
    icon: "github",
    group: "Connections",
    keywords:
      "github account device code app installations repositories personal access token connect connected accounts and access",
  },
  {
    href: "/settings/proxies",
    label: "Proxies",
    icon: "arrows-right-left",
    group: "Connections",
    keywords: "proxy cliproxyapi anthropic openai endpoint secret key connection connections upstream accounts",
  },
  {
    href: "/settings/network",
    label: "Network access",
    icon: "globe-alt",
    group: "Connections",
    keywords:
      "network listen port address hostname tailscale lan wifi firewall phones computers connect connections push relay attachments",
  },
  {
    href: "/settings/mobile",
    label: "Devices",
    icon: "device-mobile",
    group: "Connections",
    keywords:
      "phone iphone android pairing qr tailscale device revoke unpair this phone forget pairing locally mobile desktop app device access",
  },
  {
    href: "/settings/computers",
    label: "Linked computers",
    icon: "computer-desktop",
    group: "Connections",
    keywords: "computer link pair fingerprint certificate network desktop this computer configuration sharing",
  },
  {
    href: "/settings/app-updates",
    label: "App updates",
    icon: "arrow-up",
    group: "System",
    keywords:
      "app updates status check now check for updates update all progress download install restart gateway worker updates linked computers stable beta nightly channel pinned version frequency release preferences whats new release notes changelog releases",
  },
  {
    href: "/settings/workers",
    label: "Workers",
    icon: "server",
    group: "System",
    keywords:
      "worker machine environment device online config registered workers connections configuration agent CLI updates install check frequency schedule tags enrollment ssh",
  },
  {
    href: "/settings/diagnostics",
    label: "Diagnostics",
    icon: "signal",
    group: "System",
    keywords:
      "performance health storage disk space logs data cache application database rpc calls network latency rtt history findings computers sync progress remaining records errors failures linked computers overview calls and tracing reports",
  },
  {
    href: "/settings/open-source-licenses",
    label: "Open-source licenses",
    icon: "document-text",
    group: "System",
    keywords: "legal license licence third party acknowledgments notices copyright dependencies",
  },
];

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
  "/settings/memory": ["ListMemoryNotes", "UpdateMemoryNote", "DeleteMemoryNote"],
  "/settings/schedules": ["ListSchedules", "CreateSchedule"],
  "/settings/projects": ["GetOverview", "CreateProject"],
  "/settings/import": ["ScanImport", "ListImportCandidates"],
};

const desktopSection: SettingsSection = {
  href: "/settings/desktop",
  label: "Desktop",
  icon: "window",
  group: "System",
  keywords: "desktop local remote worker computer privacy analytics telemetry usage ping gateway",
};

function accessibilitySection(modules: readonly string[]): SettingsSection {
  return {
    href: "/settings/accessibility",
    label: "Accessibility",
    icon: "accessible",
    group: "Preferences",
    keywords: [
      "focus indicators keyboard navigation pointer outline ring contrast interface font size text scale",
      modules.includes("threads") && "diff colors colorblind color blind red green blue orange",
      modules.includes("bots") && "animated mascots bot animation motion",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** The guide includes all possible desktop sections and search terms. */
export const desktopSettingsSections: readonly SettingsSection[] = [
  desktopSection,
  accessibilitySection(["threads", "bots"]),
];

/** Put Accessibility beside Appearance and index the controls visible for the enabled modules. */
export function desktopSettingsNavigation(modules: readonly string[]): SettingsSection[] {
  return settingsSections.flatMap((section) => {
    if (section.href === "/settings/appearance") return [section, accessibilitySection(modules)];

    if (section.href === "/settings/app-updates") return [section, desktopSection];

    return [section];
  });
}
