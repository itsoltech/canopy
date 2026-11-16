import { createHash } from "node:crypto";

/** Local desktop gateway ports change on restart; the browser profile already isolates each desktop. */
export function gatewayPreferencesScope(gatewayUrl: string, desktop?: "local" | { fingerprint: string }): string {
  const identity = desktop === "local" ? "canopy.desktop.local" : (desktop?.fingerprint ?? gatewayUrl);

  return createHash("sha256").update(identity).digest("hex");
}
