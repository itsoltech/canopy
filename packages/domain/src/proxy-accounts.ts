import { Provider, type ui } from "@canopy/contracts";
import type { StatusLook } from "./status-look.ts";
import type { ProxyUsageSection } from "./sidebar-usage.ts";

/** How each account status reads (web: ProxyAccountRow, mobile: ProxyAccounts). */
const looks = new Map<string, StatusLook>([
  ["active", { label: "Active", tone: "emerald" }],
  ["cooling_down", { label: "Cooling down", tone: "amber" }],
  ["disabled", { label: "Off", tone: "neutral" }],
  ["sign_in", { label: "Sign in again", tone: "rose" }],
  ["error", { label: "Error", tone: "rose" }],
]);

export const proxyAccountLook = (status: string): StatusLook =>
  looks.get(status) ?? { label: "Unknown", tone: "neutral" };

/** What a state other than `ok` means, and what to do. Never the proxy's own text. */
const hints = new Map<string, string>([
  ["no_key", "Add a management key to see this proxy's accounts."],
  ["unauthorized", "The proxy rejected the management key. Replace it, then refresh."],
  ["remote_disabled", "The proxy allows management only from its own computer. Turn on remote management there."],
  ["unavailable", "The proxy's management API is off or unavailable."],
  ["unreachable", "Canopy could not reach the proxy's management API."],
  ["invalid_response", "The proxy sent an account list Canopy cannot read."],
]);

export const proxyAccountsHint = (accounts: ui.ProxyAccounts | undefined, keySet: boolean): string | undefined =>
  !keySet ? hints.get("no_key") : accounts && accounts.state !== "ok" ? hints.get(accounts.state) : undefined;

/** CLIProxyAPI provider names of a harness's upstream accounts. */
const harnessProviders = new Map<Provider, readonly string[]>([
  [Provider.CLAUDE, ["claude"]],
  [Provider.CODEX, ["codex"]],
  [Provider.GROK, ["xai", "grok"]],
]);

const marks = new Map<string, "CLAUDE" | "CODEX" | "GROK">([
  ["claude", "CLAUDE"],
  ["codex", "CODEX"],
  ["xai", "GROK"],
  ["grok", "GROK"],
]);

/** Provider key for the shared provider marks; other upstreams (Gemini, …) have no mark. */
export const proxyAccountMark = (provider: string) => marks.get(provider);

const names = new Map([
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["xai", "Grok"],
  ["grok", "Grok"],
  ["gemini", "Gemini"],
  ["gemini-cli", "Gemini"],
  ["vertex", "Vertex"],
  ["qwen", "Qwen"],
  ["kimi", "Kimi"],
  ["antigravity", "Antigravity"],
]);

export const proxyProviderName = (provider: string) => names.get(provider) ?? provider;

const counted = [
  ["cooling_down", "cooling down"],
  ["sign_in", "need sign-in"],
  ["error", "failing"],
  ["disabled", "off"],
] as const;

/**
 * One line for a harness's accounts behind a proxy, e.g. "2 Codex accounts · 1 cooling down". Undefined when the
 * accounts are unknown (no key, not read yet, an error state).
 */
export function proxyAccountsSummary(accounts: ui.ProxyAccounts | undefined, harness: Provider): string | undefined {
  if (accounts?.state !== "ok") return undefined;
  const providers = harnessProviders.get(harness) ?? [];
  const own = accounts.accounts.filter((a) => providers.includes(a.provider));
  const name = proxyProviderName(providers[0] ?? "");

  if (!own.length) return `No ${name} accounts`;
  const parts = [`${own.length} ${name} account${own.length === 1 ? "" : "s"}`];

  for (const [status, words] of counted) {
    const count = own.filter((a) => a.status === status).length;

    if (count) parts.push(`${count} ${words}`);
  }

  return parts.join(" · ");
}

/**
 * The sidebar usage popover's proxy sections (`ProxyUsageSection`, web: SidebarUsage, mobile: SidebarUsage): CLIProxyAPI
 * proxies a profile uses whose accounts the gateway has read. Plan windows are never inferred from them.
 */
export function proxyUsageSections(proxies: readonly ui.Proxy[] | undefined): ProxyUsageSection[] {
  return (proxies ?? []).flatMap((proxy) =>
    proxy.kind === "cliproxyapi" && proxy.usedBy.length && proxy.accounts?.state === "ok"
      ? [
          {
            proxyId: proxy.id,
            label: proxy.name,
            accountCount: proxy.accounts.total,
            coolingDownCount: proxy.accounts.accounts.filter((a) => a.status === "cooling_down").length,
          },
        ]
      : [],
  );
}

/** "6 accounts · 1 cooling down": the counts alone, for a second line under the proxy's name. */
export const proxyUsageCounts = (section: ProxyUsageSection) =>
  [
    `${section.accountCount} account${section.accountCount === 1 ? "" : "s"}`,
    section.coolingDownCount ? `${section.coolingDownCount} cooling down` : "",
  ]
    .filter(Boolean)
    .join(" · ");

/** "Through Team proxy: 6 accounts · 1 cooling down". */
export const proxyUsageText = (section: ProxyUsageSection) => `Through ${section.label}: ${proxyUsageCounts(section)}`;
