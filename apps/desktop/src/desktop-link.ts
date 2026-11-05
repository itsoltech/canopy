import { isOAuthState, OAUTH_RETURN_KEYS } from "@canopy/domain/oauth-return";
import type { DesktopConnectorOAuth } from "@canopy/ui/desktop";
import { origin } from "./runtime/config.ts";

interface Enrollment {
  gatewayUrl: string;
  webUrl: string;
  enrollmentToken: string;
  gatewayFingerprint: string;
}

export type DesktopLink =
  | { connectors: true; oauth?: never; enrollment?: never }
  | { oauth: DesktopConnectorOAuth; connectors?: never; enrollment?: never }
  | { enrollment: Enrollment; connectors?: never; oauth?: never };

const returnKeys = new Set<string>(OAUTH_RETURN_KEYS);

/** canopy://oauth/callback from the OAuth redirect page: provider keys only, each once, with a desktop state. */
function oauthReturn(url: URL): DesktopLink | undefined {
  if (url.pathname !== "/callback" || url.username || url.password || url.port || url.hash) return;
  const values = new Map<string, string>();

  for (const [key, value] of url.searchParams) {
    if (!returnKeys.has(key) || values.has(key)) return;
    values.set(key, value);
  }

  const state = values.get("state") ?? "";
  const code = values.get("code") ?? "";
  const error = values.get("error") ?? "";

  if (!isOAuthState(state) || !state.endsWith(".d") || (!code && !error) || code.length > 8000) return;

  return { oauth: { state, code, error, issuer: values.get("iss") ?? "" } };
}

/** A connector return can only focus settings; it cannot carry an address, state or credential. */
export function desktopLink(link: string, scheme: string): DesktopLink | undefined {
  if (link === `${scheme}://connectors`) return { connectors: true };

  try {
    const url = new URL(link);

    if (url.protocol !== `${scheme}:` || link.length > 8192) return;

    if (url.hostname === "oauth") return oauthReturn(url);

    if (url.hostname !== "enroll") return;
    const gatewayUrl = origin(url.searchParams.get("gateway"), "Gateway address");
    const webUrl = origin(url.searchParams.get("web"), "Web address");
    const enrollmentToken = url.searchParams.get("token") ?? "";
    const gatewayFingerprint = url.searchParams.get("fingerprint") ?? "";

    if (gatewayFingerprint && !/^[a-f0-9]{64}$/i.test(gatewayFingerprint)) return;

    if (enrollmentToken.length < 16 || enrollmentToken.length > 4096) return;

    return { enrollment: { gatewayUrl, webUrl, enrollmentToken, gatewayFingerprint } };
  } catch {
    /* Never log deep links containing an enrollment secret. */
    return;
  }
}
