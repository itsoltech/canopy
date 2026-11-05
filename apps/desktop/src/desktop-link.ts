import { origin } from "./runtime/config.ts";

/** A connector return can only focus settings; it cannot carry an address, state or credential. */
export function desktopLink(link: string, scheme: string) {
  if (link === `${scheme}://connectors`) return { connectors: true };

  try {
    const url = new URL(link);

    if (url.protocol !== `${scheme}:` || url.hostname !== "enroll" || link.length > 8192) return;
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
