import { isIP } from "node:net";
import type { DetectedAddress } from "./addresses.ts";

export const LOCAL_NETWORK_HELP =
  "macOS is blocking Canopy from your local network. Allow Canopy in System Settings → Privacy & Security → Local Network.";

function subnet24(host: string) {
  return host.split(".").slice(0, 3).join(".");
}

/** macOS answers "no route to host" for a device on the local network when the app lacks the
 * Local Network permission. Only an address next to one of this computer's own counts. */
export function localNetworkBlocked(
  host: string,
  code: string,
  detected: DetectedAddress[],
  platform = process.platform,
) {
  return (
    platform === "darwin" &&
    (code === "EHOSTUNREACH" || code === "ENETUNREACH") &&
    isIP(host) === 4 &&
    detected.some((a) => a.kind === "lan" && subnet24(a.host) === subnet24(host))
  );
}
