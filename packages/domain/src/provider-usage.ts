import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ProviderUsageSnapshotSchema, type ProviderUsageSnapshot, type ProviderUsageWindow } from "@canopy/contracts";

const names = new Map([
  ["usage", "Usage"],
  ["five_hour", "5-hour"],
  ["seven_day", "Weekly"],
  ["seven_day_opus", "Weekly Opus"],
  ["seven_day_sonnet", "Weekly Sonnet"],
  ["seven_day_overage_included", "Weekly included usage"],
  ["overage", "Extra usage"],
]);

export const usageWindowName = (key: string) => names.get(key) ?? "Usage";

/** Allowlist at both transport boundaries; unavailable percentages remain absent. */
export function sanitizeProviderUsage(value: ProviderUsageSnapshot): ProviderUsageSnapshot {
  const seen = new Set<string>();

  const validDate = (date: ProviderUsageWindow["resetsAt"]) =>
    date && date.seconds > 0n && date.seconds < 253402300800n && date.nanos >= 0 && date.nanos < 1e9 ? date : undefined;

  return create(ProviderUsageSnapshotSchema, {
    observedAt: validDate(value.observedAt),
    windows: value.windows
      .filter((w) => {
        if (!names.has(w.key) || seen.has(w.key)) return false;
        seen.add(w.key);

        return true;
      })
      .slice(0, 8)
      .map((w) => ({
        key: w.key,
        usedPercent:
          w.usedPercent !== undefined && Number.isFinite(w.usedPercent) && w.usedPercent >= 0
            ? Math.min(w.usedPercent, 100)
            : undefined,
        resetsAt: validDate(w.resetsAt),
        reached: w.reached,
        warning: w.warning,
      })),
    creditsAvailable: value.creditsAvailable,
    unlimitedCredits: value.unlimitedCredits,
    usingExtraUsage: value.usingExtraUsage,
  });
}

export function activeUsageWindows(snapshot: ProviderUsageSnapshot | undefined, now = Date.now()) {
  return snapshot?.windows.filter((w) => !w.resetsAt || timestampDate(w.resetsAt).getTime() > now) ?? [];
}

export function usageReset(window: ProviderUsageWindow, relative = false, now = Date.now()): string {
  if (!window.resetsAt) return "";
  const date = timestampDate(window.resetsAt);

  if (relative) {
    const minutes = Math.max(0, Math.ceil((date.getTime() - now) / 60_000));

    if (!minutes) return "Reset due";
    const hours = Math.ceil(minutes / 60);
    const number = new Intl.NumberFormat();

    return hours >= 24
      ? `Resets in ${number.format(Math.floor(hours / 24))} d ${number.format(hours % 24)} h`
      : minutes >= 60
        ? `Resets in ${number.format(hours)} h`
        : `Resets in ${number.format(minutes)} min`;
  }

  return `resets ${date.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
}

export function usageWarnings(snapshot: ProviderUsageSnapshot | undefined, now = Date.now()): string[] {
  if (!snapshot) return [];
  const windows = activeUsageWindows(snapshot, now);

  const warnings = windows
    .filter((w) => w.reached || w.warning || (w.usedPercent ?? 0) >= 90)
    .map((w) => {
      const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(w.usedPercent ?? 0);

      const title =
        w.reached || (w.usedPercent ?? 0) >= 100
          ? `${usageWindowName(w.key)} limit reached`
          : w.usedPercent === undefined
            ? `${usageWindowName(w.key)} limit is close`
            : `${usageWindowName(w.key)} limit ${percent}% used`;

      return [title, usageReset(w)].filter(Boolean).join(" · ");
    });

  const billing = usageBillingNotice(snapshot, now);

  if (billing) warnings.unshift(billing);

  return warnings;
}

export function usageBillingNotice(snapshot: ProviderUsageSnapshot | undefined, now = Date.now()): string | undefined {
  if (snapshot?.usingExtraUsage === true) return "Extra usage credits are active.";

  if (
    (snapshot?.creditsAvailable || snapshot?.unlimitedCredits) &&
    activeUsageWindows(snapshot, now).some((w) => w.reached || (w.usedPercent ?? 0) >= 100)
  )
    return "Plan limit reached. Further turns may use credits.";

  return undefined;
}

/** Stable machine-readable failure code; reset time survives persistence and later account changes. */
export function usageLimitCode(snapshot: ProviderUsageSnapshot | undefined, fallback = "usage_limit"): string {
  const window = activeUsageWindows(snapshot).find((w) => w.reached || (w.usedPercent ?? 0) >= 100);

  return window ? `usage_limit:${window.key}:${window.resetsAt?.seconds ?? ""}` : fallback;
}

export function usageFailureHeading(code: string): string | undefined {
  const match = /^usage_limit:([a-z_]+):(\d*)$/.exec(code);

  if (!match || !names.has(match[1]!)) return undefined;
  const date = match[2] ? new Date(Number(match[2]) * 1000) : undefined;

  const reset =
    date && Number.isFinite(date.getTime())
      ? ` · resets ${date.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
      : "";

  return `${usageWindowName(match[1]!)} limit reached${reset}`;
}
