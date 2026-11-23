import { CANOPY_VERSION, releaseChannel } from "@canopy/domain/release/version";
import { appIdentity } from "@canopy/domain/release/identity";
import { gateway } from "./gateway.ts";

const channelOverride = process.env["CANOPY_CHANNEL"];
export const buildIdentity = appIdentity(channelOverride || releaseChannel(CANOPY_VERSION));
let cached = buildIdentity;
let expires = 0;
let pending: Promise<typeof cached> | undefined;

/** Build identity, never the gateway's preferred update channel. Bounded during outages. */
export function shellIdentity() {
  if (Date.now() < expires) return Promise.resolve(cached);

  return (pending ??= gateway()
    .getClientCapabilities({}, { timeoutMs: 750 })
    .then(
      (info) => {
        const channel = releaseChannel(info.gatewayVersion);
        cached = info.gatewayVersion
          ? appIdentity(channel === "development" && channelOverride ? channelOverride : channel)
          : buildIdentity;
        expires = Date.now() + 5000;

        return cached;
      },
      () => {
        expires = Date.now() + 1000;

        return cached;
      },
    )
    .finally(() => {
      pending = undefined;
    }));
}
