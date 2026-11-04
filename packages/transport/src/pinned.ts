import { X509Certificate } from "node:crypto";
import { connect } from "node:tls";

export function certificatePin(raw: Buffer) {
  return new X509Certificate(raw).fingerprint256.replaceAll(":", "").toLowerCase();
}

/** Out-of-band fingerprint only. No HTTP, enrollment token or credential is sent by this handshake. */
export async function pinnedCertificate(origin: string, fingerprint: string, signal?: AbortSignal): Promise<string> {
  const url = new URL(origin);

  if (url.protocol !== "https:" || !/^[a-f0-9]{64}$/i.test(fingerprint))
    throw new Error("A pinned gateway needs HTTPS and its full SHA-256 fingerprint");

  return new Promise((resolve, reject) => {
    const socket = connect({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || 443),
      // Only a handshake: the certificate is compared before it can become trusted transport material.
      rejectUnauthorized: false,
      ...(signal && { signal }),
    });

    socket.setTimeout(5000, () => socket.destroy(new Error("Secure gateway handshake timed out")));
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      try {
        const raw = socket.getPeerCertificate().raw;

        if (!raw || certificatePin(raw) !== fingerprint.toLowerCase())
          throw new Error("Gateway certificate does not match the fingerprint");
        resolve(new X509Certificate(raw).toString());
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
  });
}
