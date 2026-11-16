import type { IconName } from "./icons.ts";

/** Settings sections with labels and aliases shared by navigation and command search. */
export interface SettingsSection {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly group: "General" | "Code" | "Connections";
  readonly keywords: string;
}

/** Match every query word in any order, ignoring case, punctuation and extra spaces. */
export function matchesSettingsSection(section: SettingsSection, query: string): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  const text = normalize(`${section.label} ${section.keywords}`);

  return normalize(query)
    .split(/\s+/)
    .every((word) => text.includes(word));
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
      "notifications sound sidebar grouping projects confirmations unpin archive delete display time zone format",
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
