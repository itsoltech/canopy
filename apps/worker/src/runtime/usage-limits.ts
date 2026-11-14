import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { ProviderUsageReportSchema, Provider, type ProviderUsageSnapshot } from "@canopy/contracts";
import { sanitizeProviderUsage, usageLimitCode } from "@canopy/domain/provider-usage";
import type { ThreadEventInit } from "../journal/index.ts";
import type { ResolvedProfile } from "../providers/profiles.ts";
import { instanceKey, wantedRuntimes } from "./instance-runtimes.ts";
import type { HostContext } from "./host-context.ts";

export interface UsageObserver {
  report(snapshot: ProviderUsageSnapshot): void;
  failure(init: ThreadEventInit): ThreadEventInit;
}

// A key or base URL replaces the device login: the harness then talks to an endpoint whose account is unknown.
const ENDPOINT_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "CODEX_BASE_URL",
  "CLIPROXY_API_KEY",
];

/**
 * Harness rate limits describe the signed-in plan only. Through a proxy, an API key or a custom endpoint they
 * belong to whatever account the endpoint picked, so they are neither shown nor stored (docs/provider-accounts.md).
 */
export function reportsPlanUsage(
  profiles: readonly ResolvedProfile[],
  baseEnv: Readonly<Record<string, string | undefined>>,
) {
  return (
    profiles.length > 0 &&
    profiles.every((p) => p.kind === "native" && !ENDPOINT_VARS.some((name) => p.env[name] || baseEnv[name]))
  );
}

/** Capture the runtime identity: a draining old home must never update a newly configured account. */
export function usageReporter(
  ctx: HostContext,
  provider: Provider,
  profileId: string,
  home: string,
  runtimeKey: string,
  plan: boolean,
) {
  const accountKey = createHash("sha256")
    .update(JSON.stringify([provider, profileId, home, runtimeKey]))
    .digest("hex");

  let latest: ProviderUsageSnapshot | undefined;
  const key = `${provider}/${profileId}`;

  const publish = () => {
    if (!latest || !plan) return;
    const version = ctx.state.config?.version;
    const harness = provider === Provider.CODEX ? "codex" : "claude";

    if (!version || wantedRuntimes(ctx).get(instanceKey(harness, profileId))?.key !== runtimeKey) return;

    const report = create(ProviderUsageReportSchema, {
      provider,
      profileId,
      configVersion: version,
      accountKey,
      snapshot: latest,
    });

    ctx.state.usage.set(key, report);
    ctx.ops.send({ case: "providerUsage", value: report });
  };

  ctx.state.usageRefreshers.set(key, publish);

  const observer: UsageObserver = {
    report: (snapshot: ProviderUsageSnapshot) => {
      if (!plan) return;
      latest = sanitizeProviderUsage(snapshot);
      publish();
    },
    failure: (init: ThreadEventInit) => usageFailure(latest, init),
  };

  ctx.state.usageObservers.set(key, observer);

  return observer;
}

function usageFailure(snapshot: ProviderUsageSnapshot | undefined, init: ThreadEventInit): ThreadEventInit {
  if (init.body?.case === "turnFinished") {
    const end = init.body.value;

    // Throughput and max-turn failures are also classified as usage limits, but do not identify a plan window.
    if (end.errorCode === "usage_limit" || end.errorCode === "usageLimitExceeded")
      end.errorCode = usageLimitCode(snapshot, end.errorCode);
  }

  return init;
}
