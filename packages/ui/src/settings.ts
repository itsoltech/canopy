import type { IconName } from "./icons.ts";

/** Settings sections with search keywords (the nav filter matches label and keywords). */
export interface SettingsSection {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly group: "General" | "Code" | "Connections";
  readonly keywords: string;
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
    keywords: "theme color scheme dark light accent chat width device",
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
    keywords: "new thread defaults model profile permissions workspace",
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
    keywords: "schedule cron recurring repeat wake-up timer automation",
  },
  {
    href: "/settings/diagnostics",
    label: "Diagnostics",
    icon: "signal",
    group: "General",
    keywords:
      "performance health rpc calls network latency rtt history findings computers sync progress remaining records errors failures linked computers",
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
    keywords: "git worktree branch base ref remote prefix semantic checkout location",
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
    keywords: "github slack outlook microsoft notion linear google atlassian mcp oauth accounts integrations access",
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
    keywords: "phone iphone android pairing qr tailscale device revoke mobile desktop app",
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
