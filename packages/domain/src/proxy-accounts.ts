import { Provider, ui } from "@canopy/contracts";
import type { StatusLook } from "./status-look.ts";

const planNames = new Map<ui.ProxyAccountPlan, string>([
  [ui.ProxyAccountPlan.FREE, "Free"],
  [ui.ProxyAccountPlan.PLUS, "Plus"],
  [ui.ProxyAccountPlan.PRO, "Pro"],
  [ui.ProxyAccountPlan.PRO_100, "Pro 100"],
  [ui.ProxyAccountPlan.PRO_200, "Pro 200"],
  [ui.ProxyAccountPlan.PRO_500, "Pro 500"],
  [ui.ProxyAccountPlan.PREMIUM, "Premium"],
  [ui.ProxyAccountPlan.SUPER, "Super"],
  [ui.ProxyAccountPlan.TEAM, "Team"],
  [ui.ProxyAccountPlan.BUSINESS, "Business"],
  [ui.ProxyAccountPlan.ENTERPRISE, "Enterprise"],
  [ui.ProxyAccountPlan.MAX, "Max"],
  [ui.ProxyAccountPlan.MAX_5X, "Max"],
  [ui.ProxyAccountPlan.MAX_20X, "Ultra"],
  [ui.ProxyAccountPlan.ULTRA, "Ultra"],
  [ui.ProxyAccountPlan.OTHER, "Other plan"],
]);

export const proxyPlanName = (plan: ui.ProxyAccountPlan) => planNames.get(plan);

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

/** Accounts reported by this proxy for the instance's harness. */
export function proxyAccountsForHarness(accounts: ui.ProxyAccounts | undefined, harness: Provider): ui.ProxyAccount[] {
  const providers = harnessProviders.get(harness);

  return accounts?.state === "ok" && providers ? accounts.accounts.filter((a) => providers.includes(a.provider)) : [];
}

/**
 * One line for a harness's accounts behind a proxy, e.g. "2 Codex accounts · 1 cooling down". Undefined when the
 * accounts are unknown (no key, not read yet, an error state).
 */
export function proxyAccountsSummary(accounts: ui.ProxyAccounts | undefined, harness: Provider): string | undefined {
  if (accounts?.state !== "ok") return undefined;
  const providers = harnessProviders.get(harness) ?? [];
  const own = proxyAccountsForHarness(accounts, harness);
  const name = proxyProviderName(providers[0] ?? "");

  if (!own.length) return `No ${name} accounts`;
  const parts = [`${own.length} ${name} account${own.length === 1 ? "" : "s"}`];

  for (const [status, words] of counted) {
    const count = own.filter((a) => a.status === status).length;

    if (count) parts.push(`${count} ${words}`);
  }

  return parts.join(" · ");
}

/** Kind picker options; `compatibility` is the hint under the picker: which agents can use the kind. */
export const proxyKinds = [
  {
    value: "cliproxyapi",
    label: "CLIProxyAPI or a fork",
    description: "Claude, Codex and Grok through one connection.",
    compatibility: "Claude, Codex and Grok can all use it.",
  },
  {
    value: "anthropic",
    label: "Anthropic-compatible",
    description: "Messages API for Claude.",
    compatibility: "Only Claude can use it. Codex and Grok need an OpenAI-compatible proxy.",
  },
  {
    value: "openai",
    label: "OpenAI-compatible",
    description: "Responses API for Codex; Chat Completions for Grok.",
    compatibility: "Codex and Grok can use it. Claude needs an Anthropic-compatible proxy.",
  },
] as const;

export const supportsHarness = (proxy: Pick<ui.Proxy, "kind">, harness: Provider) =>
  harnessProviders.has(harness) &&
  (proxy.kind === "cliproxyapi" ||
    (proxy.kind === "anthropic" && harness === Provider.CLAUDE) ||
    (proxy.kind === "openai" && (harness === Provider.CODEX || harness === Provider.GROK)));
