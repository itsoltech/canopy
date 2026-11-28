import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { codexQuotaPeriod, isUsageResetPlausible } from "@canopy/domain/provider-usage";

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
    const absoluteReset = reset(number(signals.get(`${prefix}reset-at`)), now);

    const resetsAt =
      absoluteReset ??
      (observed && after !== undefined && after >= 0 ? reset(observed.getTime() / 1000 + after, now) : undefined);

    if (usedPercent === undefined || (!windowMinutes && !resetsAt && usedPercent === 0)) continue;
    result.push({
      key: codexQuotaPeriod(windowMinutes) ?? `${slot}_limit`,
      windowMinutes,
      usedPercent,
      resetsAt,
      reached: usedPercent >= 100,
      // An estimated deadline can be displayed, but only the upstream epoch identifies
      // the same renewal across both proxy and direct reads.
      observedAt: absoluteReset && observed && timestampFromDate(observed),
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
    result.push({
      key,
      windowMinutes,
      usedPercent,
      resetsAt,
      reached,
      observedAt: observed && timestampFromDate(observed),
    });
  }

  return result;
}
