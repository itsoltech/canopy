import {
  USAGE_TRANSITION_PREFIXES,
  USAGE_WARNING_PREFIXES,
  USAGE_LIMIT_ERROR_PREFIXES,
  type SDKMessage,
  type SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk";
import type { v2 } from "@canopy/codex-protocol";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate, timestampNow } from "@bufbuild/protobuf/wkt";
import { ProviderUsageSnapshotSchema, type ProviderUsageSnapshot } from "@canopy/contracts";
import { sanitizeProviderUsage } from "@canopy/domain/provider-usage";

const reset = (seconds: number | null | undefined) =>
  seconds && Number.isFinite(seconds) && seconds > 0 && seconds < 253402300800
    ? timestampFromDate(new Date(seconds * 1000))
    : undefined;

const codexWindows = new Map([
  [300, "five_hour"],
  [10080, "seven_day"],
]);

export function codexUsage(snapshot: v2.RateLimitSnapshot): ProviderUsageSnapshot {
  return sanitizeProviderUsage(
    create(ProviderUsageSnapshotSchema, {
      observedAt: timestampNow(),
      windows: [snapshot.primary, snapshot.secondary].flatMap((window) =>
        window
          ? [
              {
                key: codexWindows.get(window.windowDurationMins ?? 0) ?? "usage",
                usedPercent: window.usedPercent,
                resetsAt: reset(window.resetsAt),
                reached: window.usedPercent >= 100,
              },
            ]
          : [],
      ),
      creditsAvailable: snapshot.credits?.hasCredits,
      unlimitedCredits: snapshot.credits?.unlimited,
    }),
  );
}

/** Claude sends one window per event; preserve other reported windows within this runtime identity. */
export function claudeUsage(info: SDKRateLimitInfo, previous?: ProviderUsageSnapshot): ProviderUsageSnapshot {
  const key = info.rateLimitType ?? "usage";
  const windows = previous?.windows.filter((window) => window.key !== key) ?? [];

  if (key)
    windows.push(
      create(ProviderUsageSnapshotSchema, {
        windows: [
          {
            key,
            usedPercent: info.utilization === undefined ? undefined : info.utilization * 100,
            resetsAt: reset(info.resetsAt),
            reached: info.status === "rejected",
            warning: info.status === "allowed_warning",
          },
        ],
      }).windows[0]!,
    );

  return sanitizeProviderUsage(
    create(ProviderUsageSnapshotSchema, {
      windows,
      observedAt: timestampNow(),
      usingExtraUsage: info.isUsingOverage ?? info.overageInUse ?? previous?.usingExtraUsage,
      creditsAvailable: info.overageEnabled ?? previous?.creditsAvailable,
    }),
  );
}

export const claudeLimitError = (text: string) => USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix));

/** Only official SDK notification prefixes; arbitrary assistant prose cannot assert a billing transition. */
export function claudeUsageNotification(message: SDKMessage, previous?: ProviderUsageSnapshot) {
  if (message.type !== "system" || message.subtype !== "notification") return undefined;

  if (USAGE_TRANSITION_PREFIXES.some((prefix) => message.text.startsWith(prefix)))
    return create(ProviderUsageSnapshotSchema, {
      windows: previous?.windows ?? [],
      creditsAvailable: previous?.creditsAvailable,
      unlimitedCredits: previous?.unlimitedCredits,
      observedAt: timestampNow(),
      usingExtraUsage: true,
    });

  if (USAGE_WARNING_PREFIXES.some((prefix) => message.text.startsWith(prefix)))
    return claudeUsage({ status: "allowed_warning" }, previous);

  return undefined;
}
