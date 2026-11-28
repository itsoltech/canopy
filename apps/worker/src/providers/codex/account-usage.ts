import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  CodexQuotaObservationSchema,
  ProviderUsageWindowSchema,
  type CodexQuotaObservation,
  type ProviderUsageSnapshot,
} from "@canopy/contracts";
import type { v2 } from "@canopy/codex-protocol";
import { codexQuotaAccountIdentity, codexQuotaPeriod, isUsageResetPlausible } from "@canopy/domain/provider-usage";
import { Effect, Schedule } from "effect";
import { codexUsage } from "../usage-limits.ts";
import { CodexThreadError, type CodexThreadContext } from "./thread-types.ts";

const historyMs = 10 * 60_000;
const leadTimeMs = 2 * 60_000;

function isAccountBound(result: v2.GetAccountRateLimitsResponse) {
  // app-server validates this field against both the active workspace and the active user.
  return result.ordinaryUsageAllowed === true || result.ordinaryUsageAllowed === false;
}

function quotaObservation(
  result: v2.GetAccountRateLimitsResponse,
  account: v2.Account | null,
  sessionKey: string,
  requestedAt: number,
) {
  const limits = result.rateLimitsByLimitId?.["codex"];

  if (!limits || !isAccountBound(result) || !result.accountId || account?.type !== "chatgpt" || !account.email)
    return null;
  const identity = codexQuotaAccountIdentity(result.accountId, account.email);

  if (!identity) return null;
  const candidates = [limits.primary, limits.secondary];

  const windows = candidates.flatMap((window) => {
    if (
      !window?.windowDurationMins ||
      !window.resetsAt ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0
    )
      return [];
    const key = codexQuotaPeriod(window.windowDurationMins);
    const resetAt = window.resetsAt * 1000;

    // A missing deadline or two slots with the same duration do not identify a rolling window.
    if (
      !key ||
      !isUsageResetPlausible(resetAt, requestedAt) ||
      candidates.filter((other) => other?.windowDurationMins === window.windowDurationMins).length !== 1
    )
      return [];

    return [
      create(ProviderUsageWindowSchema, {
        key,
        windowMinutes: window.windowDurationMins,
        usedPercent: window.usedPercent,
        resetsAt: timestampFromDate(new Date(resetAt)),
        reached: window.usedPercent >= 100,
      }),
    ];
  });

  return create(CodexQuotaObservationSchema, {
    accountKey: createHash("sha256").update(identity).digest("hex"),
    sessionKey,
    observedAt: timestampFromDate(new Date(requestedAt)),
    ordinaryUsageAllowed: result.ordinaryUsageAllowed === true,
    windows,
  });
}

function exhaustedResets({ windows }: Pick<ProviderUsageSnapshot, "windows">): number[] {
  const now = Date.now();

  return windows.flatMap((window) => {
    if (!window.reached || !window.resetsAt) return [];
    const deadline = timestampDate(window.resetsAt).getTime();

    return isUsageResetPlausible(deadline, now) && now - deadline <= historyMs ? [deadline] : [];
  });
}

export function trackCodexUsage({ codex, options }: CodexThreadContext) {
  let revision = 0;
  let sessionKey = crypto.randomUUID();
  let pending: number[] = [];
  const account = () => codex.request("account/read", { refreshToken: false });

  const accountEmail = () =>
    account().pipe(
      Effect.map((result) => (result.account?.type === "chatgpt" ? result.account.email : null)),
      Effect.orElseSucceed(() => null),
    );

  const read = Effect.suspend(() => {
    const started = ++revision;
    const requestedAt = Date.now();
    const session = sessionKey;

    return Effect.gen(function* () {
      const login = options.readQuota ? yield* accountEmail() : null;
      const result = yield* codex.request("account/rateLimits/read", { excludeResetCreditDetails: true });
      let quota: CodexQuotaObservation | null = null;

      if (login && isAccountBound(result) && result.accountId) {
        const current = yield* account().pipe(Effect.orElseSucceed(() => undefined));

        if (current?.account?.type === "chatgpt" && current.account.email === login)
          quota = quotaObservation(result, current.account, session, requestedAt);
      }

      if (started !== revision || !result.rateLimits) return;

      // Older app-servers can still provide display windows without an account-bound read.
      if (quota?.ordinaryUsageAllowed) pending = exhaustedResets(quota);
      else if (quota)
        pending = [...new Set([...pending.filter((at) => Date.now() <= at + historyMs), ...exhaustedResets(quota)])];
      options.onUsage?.(codexUsage(result.rateLimits), quota);
    }).pipe(Effect.timeout("3 seconds"), Effect.ignore);
  });

  return {
    read,
    poll: Effect.suspend(() => {
      const now = Date.now();

      return pending.some((at) => at - leadTimeMs <= now && now <= at + historyMs) ? read : Effect.void;
    }).pipe(Effect.repeat(Schedule.spaced("1 minute"))),
    accountChanged() {
      revision++;
      sessionKey = crypto.randomUUID();
      pending = [];
    },
    update(rateLimits: v2.AccountRateLimitsUpdatedNotification["rateLimits"]) {
      revision++;
      const snapshot = codexUsage(rateLimits);

      const deadlines = options.readQuota ? exhaustedResets(snapshot) : [];
      const firstExhaustion = deadlines.some((at) => !pending.includes(at));

      if (firstExhaustion) pending = [...new Set([...pending, ...deadlines])];
      options.onUsage?.(snapshot);

      return firstExhaustion;
    },
    readAccount: () =>
      account().pipe(
        Effect.tap(() => (options.onUsage ? read : Effect.void)),
        Effect.map((result) =>
          result.account?.type === "chatgpt"
            ? { email: result.account.email ?? "", plan: result.account.planType }
            : undefined,
        ),
        Effect.mapError(
          () =>
            new CodexThreadError({
              threadId: "",
              operation: "account/read",
              message: "Could not read account metadata.",
            }),
        ),
      ),
  };
}
