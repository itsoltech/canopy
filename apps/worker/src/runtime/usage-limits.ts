import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { ProviderUsageReportSchema, Provider, type ProviderUsageSnapshot } from "@canopy/contracts";
import { sanitizeProviderUsage, usageLimitCode } from "@canopy/domain/provider-usage";
import type { ThreadEventInit } from "../journal/index.ts";
import { instanceKey, wantedRuntimes } from "./instance-runtimes.ts";
import type { HostContext } from "./host-context.ts";

export interface UsageObserver {
  report(snapshot: ProviderUsageSnapshot): void;
  failure(init: ThreadEventInit): ThreadEventInit;
}

/** Capture the runtime identity: a draining old home must never update a newly configured account. */
export function usageReporter(
  ctx: HostContext,
  provider: Provider,
  profileId: string,
  home: string,
  runtimeKey: string,
) {
  const accountKey = createHash("sha256")
    .update(JSON.stringify([provider, profileId, home, runtimeKey]))
    .digest("hex");

  let latest: ProviderUsageSnapshot | undefined;
  const key = `${provider}/${profileId}`;

  const publish = () => {
    if (!latest) return;
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
