import { Provider, type ProviderUsageWindow, type ui } from "@canopy/contracts";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { activeUsageWindows, usageReset, usageWindowName } from "./provider-usage.ts";
import { proxyAccountMark } from "./proxy-accounts.ts";
import {
  eligibleProxyAccount,
  proxyCapacityGroups,
  proxyPlanLimits,
  supportedProxyAccounts,
} from "./proxy-capacity.ts";
import { usageTone, type SidebarUsageAccount, type UsageGlance, type UsageTone } from "./sidebar-usage.ts";

/** One limit window of a provider row: the lowest reading of all its accounts, weighted for proxies. */
export interface SummaryWindow {
  readonly name: string;
  readonly minutes: number;
  readonly percentLeft: number;
  readonly resetsAt: ProviderUsageWindow["resetsAt"];
}

/**
 * One account's column in a row's bars: as wide as its plan units in the main window, in the same place in
 * every bar. When there is no reading, only a confirmed plan rule can set `noLimit`.
 */
export interface SummarySegment {
  readonly noLimit: boolean;
  readonly units: number;
  readonly percentLeft: number | undefined;
}

/** A shorter window of a row with one column per account, lined up with the main bar. */
export interface SummaryMeter {
  readonly window: SummaryWindow;
  readonly segments: readonly SummarySegment[];
}

/** One provider in the usage summary (web and mobile SidebarUsage). */
export interface UsageSummaryRow {
  readonly provider: Provider;
  readonly name: string;
  /** The longest general window; absent only while extra usage is the sole reading. */
  readonly window: SummaryWindow | undefined;
  /** A shorter window with less left than `window`: the limit that binds first. */
  readonly binding: SummaryWindow | undefined;
  /**
   * One column per account in `window`, largest plan first. Proxy accounts weigh their plan's units; a direct
   * sign-in has no known plan and counts as 1, like an unknown proxy plan.
   */
  readonly segments: readonly SummarySegment[];
  /**
   * Shorter general windows (e.g. 5-hour), shortest first, shown above `window`. Each has the same columns;
   * accounts without a reading retain their columns.
   */
  readonly shorter: readonly SummaryMeter[];
  /** Aligned columns when a plan has a five-hour cap but no account reports a current reading. */
  readonly fiveHourPlaceholder: readonly SummarySegment[];
  readonly tone: UsageTone;
  readonly word: "Low" | "Extra usage" | undefined;
}

/** A proxy in use whose accounts the summary cannot include yet. */
export interface UsageSummaryNote {
  readonly proxyId: string;
  readonly text: string;
  readonly checking: boolean;
}

const providers = [
  { provider: Provider.CLAUDE, mark: "CLAUDE", name: "Claude" },
  { provider: Provider.CODEX, mark: "CODEX", name: "Codex" },
  { provider: Provider.GROK, mark: "GROK", name: "Grok" },
] as const;

const fiveHours = 300;
const oneWeek = 10080;

/** Windows for the whole account. Model-specific and unknown-period limits stay in Settings. */
const general = new Map([
  ["five_hour", fiveHours],
  ["one_day", 1440],
  ["seven_day", oneWeek],
  ["thirty_day", 43200],
]);

const minutesOf = (key: string, windowMinutes: number) =>
  general.get(key) ?? (key === "duration" && windowMinutes > 0 ? windowMinutes : undefined);

const earlier = (a: ProviderUsageWindow["resetsAt"], b: ProviderUsageWindow["resetsAt"]) =>
  !a ? b : !b ? a : timestampDate(a) <= timestampDate(b) ? a : b;

function add(
  windows: Map<number, SummaryWindow>,
  key: string,
  windowMinutes: number,
  left: number,
  resetsAt: SummaryWindow["resetsAt"],
) {
  const minutes = minutesOf(key, windowMinutes);

  if (minutes === undefined || !Number.isFinite(left)) return;
  const percentLeft = Math.max(0, Math.min(100, left));
  const previous = windows.get(minutes);

  if (previous && previous.percentLeft < percentLeft) return;
  windows.set(minutes, {
    name: usageWindowName(key, windowMinutes),
    minutes,
    percentLeft,
    resetsAt: previous?.percentLeft === percentLeft ? earlier(previous.resetsAt, resetsAt) : resetsAt,
  });
}

type ColumnAccount = ui.ProxyAccount | SidebarUsageAccount;

interface AccountColumn {
  readonly plan: ReturnType<typeof proxyPlanLimits>;
  readonly readings: Map<number, { units: number; left: number }>;
}

/** Account objects distinguish matching IDs behind different proxies. */
class Columns {
  private readonly list = new Map<ColumnAccount, AccountColumn>();

  include(account: ColumnAccount) {
    this.list.set(account, {
      plan: "plan" in account ? proxyPlanLimits(account) : undefined,
      readings: new Map(),
    });
  }

  record(account: ColumnAccount, minutes: number, units: number, left: number) {
    const readings = this.list.get(account)?.readings;

    if (!readings) return;
    const previous = readings.get(minutes);
    readings.set(minutes, {
      units: previous?.units ?? units,
      left: Math.min(previous?.left ?? 100, Math.max(0, left)),
    });
  }

  bar(main: SummaryWindow, minutes: number): SummarySegment[] {
    return [...this.list.values()]
      .map(({ plan, readings }) => {
        const percentLeft = readings.get(minutes)?.left;
        const mainUnits = readings.get(main.minutes)?.units ?? (main.minutes === oneWeek ? plan?.seven_day : undefined);

        return {
          noLimit: minutes === fiveHours && percentLeft === undefined && plan?.five_hour === null,
          units: mainUnits ?? readings.values().next().value?.units ?? 1,
          percentLeft,
        };
      })
      .sort((a, b) => b.units - a.units);
  }

  fiveHourPlaceholder(main: SummaryWindow, windows: ReadonlyMap<number, SummaryWindow>): SummarySegment[] {
    if (windows.has(fiveHours)) return [];
    const hasCappedPlan = [...this.list.values()].some(({ plan }) => plan?.five_hour != null);

    return hasCappedPlan ? this.bar(main, fiveHours) : [];
  }
}

const proxyAccounts = (proxy: ui.Proxy) =>
  proxy.kind === "cliproxyapi" && proxy.usedBy.length && proxy.accounts?.state === "ok" ? proxy.accounts.accounts : [];

/** Current account readings on the Providers page, grouped by their source. */
export function usageProxyLimits(proxies: readonly ui.Proxy[], now = Date.now()) {
  return proxies.flatMap((proxy) => {
    const accounts = supportedProxyAccounts(proxyAccounts(proxy)).filter(
      (account) => activeUsageWindows(account, now).length,
    );

    return accounts.length ? [{ proxy, accounts }] : [];
  });
}

/**
 * How much each provider has left, in one row: weighted proxy capacity (`proxy-capacity`) and direct instance
 * readings per window, keeping the lowest. Pure projection of cached data; never triggers reads.
 */
export function usageSummary(
  direct: readonly SidebarUsageAccount[],
  proxies: readonly ui.Proxy[],
  now = Date.now(),
): UsageSummaryRow[] {
  const accounts = proxies.flatMap(proxyAccounts);
  const groups = proxyCapacityGroups(accounts, now);

  return providers.flatMap(({ provider, mark, name }) => {
    const own = direct.filter((account) => account.provider === provider);
    const group = groups.find((item) => item.mark === mark);

    if (!own.length && !group) return [];
    const windows = new Map<number, SummaryWindow>();
    const columns = new Columns();

    for (const account of accounts)
      if (proxyAccountMark(account.provider) === mark && eligibleProxyAccount(account)) columns.include(account);

    // Lowest first, so an account in two proxy windows of the same length keeps that window's units.
    for (const window of group?.windows ?? []) {
      const minutes = minutesOf(window.key, window.windowMinutes);

      if (minutes !== undefined)
        for (const segment of window.segments)
          columns.record(segment.account, minutes, segment.units, segment.percentLeft);
      add(windows, window.key, window.windowMinutes, window.percentLeft, window.resetsAt);
    }

    for (const account of own) {
      columns.include(account);

      for (const window of activeUsageWindows(account.usage, now)) {
        if (!window.reached && window.usedPercent === undefined) continue;
        const left = window.reached ? 0 : 100 - window.usedPercent!;
        const minutes = minutesOf(window.key, window.windowMinutes);
        add(windows, window.key, window.windowMinutes, left, window.resetsAt);

        if (minutes !== undefined && Number.isFinite(left)) columns.record(account, minutes, 1, left);
      }
    }

    const sorted = [...windows.values()].sort((a, b) => b.minutes - a.minutes);
    const main = sorted[0];
    const lowest = sorted.slice(1).sort((a, b) => a.percentLeft - b.percentLeft)[0];
    const binding = main && lowest && lowest.percentLeft < main.percentLeft ? lowest : undefined;
    const left = binding?.percentLeft ?? main?.percentLeft;
    const extra = own.some((account) => account.usage.usingExtraUsage === true);
    const tone = usageTone(left === undefined ? 0 : 100 - left, extra);

    // A provider without a reading is a minor gap: Settings has the per-account detail.
    if (!main && !extra) return [];

    return [
      {
        provider,
        name,
        window: main,
        binding,
        segments: main ? columns.bar(main, main.minutes) : [],
        fiveHourPlaceholder: main ? columns.fiveHourPlaceholder(main, windows) : [],
        shorter: main
          ? sorted
              .slice(1)
              .reverse()
              .map((window) => ({ window, segments: columns.bar(main, window.minutes) }))
          : [],
        tone,
        word: extra ? "Extra usage" : left !== undefined && left <= 10 ? "Low" : undefined,
      },
    ];
  });
}

const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** The value of an individual account's column, including windows without a reading. */
export const segmentValueText = (segment: SummarySegment): string =>
  segment.percentLeft !== undefined
    ? `${whole.format(segment.percentLeft)}%`
    : segment.noLimit
      ? "No limit"
      : "No reading";

export const segmentUsageLabel = (segment: SummarySegment, index: number, period: string) =>
  `Account ${index + 1}, ${period}, ${segmentValueText(segment)}${segment.percentLeft === undefined ? "" : " left"}`;

export const percentLeftText = (window?: SummaryWindow) =>
  window ? `${whole.format(window.percentLeft)}% left` : "No reading";

/** "Weekly · Resets in 2 d 6 h": the window the bar shows and its reset. */
export const summaryWindowText = (window: SummaryWindow, now = Date.now()) =>
  [window.name, usageReset(window, true, now)].filter(Boolean).join(" · ");

/** "5-hour: 12% left · Resets in 2 h", for a shorter window in the accessible name. */
const shorterText = (window: SummaryWindow, now: number) =>
  [`${window.name}: ${percentLeftText(window)}`, usageReset(window, true, now)].filter(Boolean).join(" · ");

/** "3 accounts" beside the name when the bar is split; a single account needs no count. */
export const accountsText = (row: UsageSummaryRow) =>
  row.segments.length > 1 ? `${row.segments.length} accounts` : "";

/** Visible facts of a row in one sentence, for its accessible name and the trigger label. */
export function usageSummaryLabel(row: UsageSummaryRow, now = Date.now()) {
  const parts = [
    row.window ? `${row.name}: ${percentLeftText(row.window)}` : row.name,
    accountsText(row),
    row.window ? summaryWindowText(row.window, now) : "",
    row.fiveHourPlaceholder.length ? "5-hour: No reading" : "",
    ...row.shorter.map((meter) => shorterText(meter.window, now)),
    row.word ?? "",
  ];

  return parts.filter(Boolean).join(", ");
}

/**
 * The sidebar indicator: one bar per row, filled like the row's bar in the popover (its main window). The tone
 * still follows a binding shorter window, as the row's "Low" word does.
 */
export const usageSummaryGlance = (rows: readonly UsageSummaryRow[], now = Date.now()): UsageGlance[] =>
  rows.map((row) => ({
    provider: row.provider,
    name: row.name,
    percentLeft: row.window?.percentLeft,
    tone: row.tone,
    label: usageSummaryLabel(row, now),
  }));

/** One short line per proxy in use whose accounts are not readable yet; per-account detail stays in Settings. */
export const usageSummaryNotes = (proxies: readonly ui.Proxy[]): UsageSummaryNote[] =>
  proxies.flatMap((proxy): UsageSummaryNote[] =>
    proxy.kind !== "cliproxyapi" || !proxy.usedBy.length || proxy.accounts?.state === "ok"
      ? []
      : proxy.accounts || !proxy.managementKeySet
        ? [{ proxyId: proxy.id, text: `Canopy can’t read accounts from “${proxy.name}”.`, checking: false }]
        : [{ proxyId: proxy.id, text: `Checking accounts from “${proxy.name}”…`, checking: true }],
  );
