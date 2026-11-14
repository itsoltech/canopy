import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { isUsageResetPlausible } from "@canopy/domain/provider-usage";

const periods = new Map([
  [300, "five_hour"],
  [1440, "one_day"],
  [10080, "seven_day"],
  [43200, "thirty_day"],
]);

const number = (value: string | undefined) =>
  value?.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;

const percent = (value: number | undefined) => (value !== undefined && value >= 0 ? Math.min(value, 100) : undefined);

function reset(seconds: number | undefined, now: number) {
  return seconds !== undefined && isUsageResetPlausible(seconds * 1000, now)
    ? timestampFromDate(new Date(seconds * 1000))
    : undefined;
}

/** Slot order is not duration: weekly-only Codex plans use primary and can send an empty secondary. */
export function proxyUsageWindows(signals: ReadonlyMap<string, string>, observed: Date | undefined, now: number) {
  const result = [];

  for (const slot of ["primary", "secondary"]) {
    const prefix = `x-codex-${slot}-`;
    const usedPercent = percent(number(signals.get(`${prefix}used-percent`)));
    const duration = number(signals.get(`${prefix}window-minutes`));

    const windowMinutes =
      duration && Number.isSafeInteger(duration) && duration > 0 && duration <= 525600 ? duration : 0;

    const after = number(signals.get(`${prefix}reset-after-seconds`));

    const resetsAt =
      reset(number(signals.get(`${prefix}reset-at`)), now) ??
      (observed && after !== undefined && after >= 0 ? reset(observed.getTime() / 1000 + after, now) : undefined);

    if (usedPercent === undefined || (!windowMinutes && !resetsAt && usedPercent === 0)) continue;
    result.push({
      key: periods.get(windowMinutes) ?? (windowMinutes ? "duration" : `${slot}_limit`),
      windowMinutes,
      usedPercent,
      resetsAt,
      reached: usedPercent >= 100,
    });
  }

  for (const [span, key, windowMinutes] of [
    ["5h", "five_hour", 300],
    ["7d", "seven_day", 10080],
  ] as const) {
    const prefix = `anthropic-ratelimit-unified-${span}-`;
    const utilization = number(signals.get(`${prefix}utilization`));
    const usedPercent = percent(utilization === undefined ? undefined : utilization * 100);
    const resetsAt = reset(number(signals.get(`${prefix}reset`)), now);
    const status = signals.get(`${prefix}status`);
    const reached = status === "rejected" || (usedPercent ?? 0) >= 100;

    if (usedPercent === undefined && !reached) continue;

    if (!usedPercent && !resetsAt && !status) continue;
    result.push({ key, windowMinutes, usedPercent, resetsAt, reached });
  }

  return result;
}
