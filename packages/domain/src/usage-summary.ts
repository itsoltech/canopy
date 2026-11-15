import { Provider, type ProviderUsageWindow, type ui } from "@canopy/contracts";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { activeUsageWindows, usageReset, usageWindowName } from "./provider-usage.ts";
import { proxyCapacityGroups, type CapacitySegment } from "./proxy-capacity.ts";
import { usageTone, type SidebarUsageAccount, type UsageGlance, type UsageTone } from "./sidebar-usage.ts";

/** One limit window of a provider row: the lowest reading of all its accounts, weighted for proxies. */
export interface SummaryWindow {
  readonly name: string;
  readonly minutes: number;
  readonly percentLeft: number;
  readonly resetsAt: ProviderUsageWindow["resetsAt"];
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
   * The accounts behind `window`, one bar each, largest plan first. Proxy accounts weigh their plan's units;
   * a direct sign-in has no known plan and counts as 1, like an unknown proxy plan.
   */
  readonly segments: readonly CapacitySegment[];
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

/** Windows for the whole account. Model-specific and unknown-period limits stay in Settings. */
const general = new Map([
  ["five_hour", 300],
  ["one_day", 1440],
  ["seven_day", 10080],
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

const proxyAccounts = (proxies: readonly ui.Proxy[]) =>
  proxies.flatMap((proxy) =>
    proxy.kind === "cliproxyapi" && proxy.usedBy.length && proxy.accounts?.state === "ok"
      ? proxy.accounts.accounts
      : [],
  );

/**
 * How much each provider has left, in one row: weighted proxy capacity (`proxy-capacity`) and direct instance
 * readings per window, keeping the lowest. Pure projection of cached data; never triggers reads.
 */
export function usageSummary(
  direct: readonly SidebarUsageAccount[],
  proxies: readonly ui.Proxy[],
  now = Date.now(),
): UsageSummaryRow[] {
  const groups = proxyCapacityGroups(proxyAccounts(proxies), now);

  return providers.flatMap(({ provider, mark, name }) => {
    const own = direct.filter((account) => account.provider === provider);
    const group = groups.find((item) => item.mark === mark);

    if (!own.length && !group) return [];
    const windows = new Map<number, SummaryWindow>();
    const segments = new Map<number, CapacitySegment[]>();

    const segment = (minutes: number, list: readonly CapacitySegment[]) =>
      segments.set(minutes, [...(segments.get(minutes) ?? []), ...list]);

    // Lowest first: a second proxy window of the same length would count its accounts twice.
    for (const window of group?.windows ?? []) {
      const minutes = minutesOf(window.key, window.windowMinutes);

      if (minutes !== undefined && !segments.has(minutes)) segment(minutes, window.segments);
      add(windows, window.key, window.windowMinutes, window.percentLeft, window.resetsAt);
    }

    for (const account of own) {
      const lefts = new Map<number, number>();

      for (const window of activeUsageWindows(account.usage, now)) {
        if (!window.reached && window.usedPercent === undefined) continue;
        const left = window.reached ? 0 : 100 - window.usedPercent!;
        const minutes = minutesOf(window.key, window.windowMinutes);
        add(windows, window.key, window.windowMinutes, left, window.resetsAt);

        if (minutes !== undefined && Number.isFinite(left))
          lefts.set(minutes, Math.min(lefts.get(minutes) ?? 100, Math.max(0, left)));
      }

      for (const [minutes, left] of lefts) segment(minutes, [{ units: 1, percentLeft: left }]);
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

    const parts = main ? (segments.get(main.minutes) ?? []) : [];

    return [
      {
        provider,
        name,
        window: main,
        binding,
        segments: main && !parts.length ? [{ units: 1, percentLeft: main.percentLeft }] : byUnits(parts),
        tone,
        word: extra ? "Extra usage" : left !== undefined && left <= 10 ? "Low" : undefined,
      },
    ];
  });
}

const byUnits = (segments: readonly CapacitySegment[]) => [...segments].sort((a, b) => b.units - a.units);

const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** "44% left". */
export const percentLeftText = (window: SummaryWindow) => `${whole.format(window.percentLeft)}% left`;

/** "Weekly · Resets in 2 d 6 h": the window the bar shows and its reset. */
export const summaryWindowText = (window: SummaryWindow, now = Date.now()) =>
  [window.name, usageReset(window, true, now)].filter(Boolean).join(" · ");

/** "5-hour: 12% left". */
export const bindingText = (window: SummaryWindow) => `${window.name}: ${percentLeftText(window)}`;

/** "3 accounts" beside the name when the bar is split; a single account needs no count. */
export const accountsText = (row: UsageSummaryRow) =>
  row.segments.length > 1 ? `${row.segments.length} accounts` : "";

/** Visible facts of a row in one sentence, for its accessible name and the trigger label. */
export function usageSummaryLabel(row: UsageSummaryRow, now = Date.now()) {
  const parts = [
    row.window ? `${row.name}: ${percentLeftText(row.window)}` : row.name,
    accountsText(row),
    row.window ? summaryWindowText(row.window, now) : "",
    row.binding ? bindingText(row.binding) : "",
    row.word ?? "",
  ];

  return parts.filter(Boolean).join(", ");
}

/** The sidebar indicator: one bar per row, filled to the most restrictive window. */
export const usageSummaryGlance = (rows: readonly UsageSummaryRow[], now = Date.now()): UsageGlance[] =>
  rows.map((row) => {
    const left = row.binding?.percentLeft ?? row.window?.percentLeft;

    return {
      provider: row.provider,
      name: row.name,
      percentLeft: left,
      tone: row.tone,
      label: usageSummaryLabel(row, now),
    };
  });

/** One short line per proxy in use whose accounts are not readable yet; per-account detail stays in Settings. */
export const usageSummaryNotes = (proxies: readonly ui.Proxy[]): UsageSummaryNote[] =>
  proxies.flatMap((proxy): UsageSummaryNote[] =>
    proxy.kind !== "cliproxyapi" || !proxy.usedBy.length || proxy.accounts?.state === "ok"
      ? []
      : proxy.accounts || !proxy.managementKeySet
        ? [{ proxyId: proxy.id, text: `Canopy can’t read accounts from “${proxy.name}”.`, checking: false }]
        : [{ proxyId: proxy.id, text: `Checking accounts from “${proxy.name}”…`, checking: true }],
  );
