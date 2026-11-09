import { CANOPY_VERSION, releaseChannel } from "@canopy/domain/release/version";
import { releaseIdentity } from "@canopy/domain/release/identity";
import { gateway } from "./gateway.ts";

function fallbackIdentity() {
  const channel = process.env["CANOPY_CHANNEL"] ?? releaseChannel(CANOPY_VERSION);

  return releaseIdentity(channel === "development" ? "stable" : channel);
}

let cached = fallbackIdentity();
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
        cached = channel === "development" ? fallbackIdentity() : releaseIdentity(channel);
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
