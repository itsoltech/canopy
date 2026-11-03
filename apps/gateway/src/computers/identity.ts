import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { X509CertificateGenerator, BasicConstraintsExtension, KeyUsagesExtension, KeyUsageFlags } from "@peculiar/x509";
import { Code, ConnectError } from "@connectrpc/connect";

export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function certificateIdentity(pem: string | Uint8Array) {
  const cert = new X509Certificate(pem);
  if (!cert.verify(cert.publicKey) || Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) {
    throw new ConnectError("Invalid computer certificate", Code.Unauthenticated);
  }
  return { certificate: cert.toString(), fingerprint: hash(cert.raw), nodeId: hash(cert.publicKey.export({ type: "spki", format: "der" })) };
}
export async function generateIdentity() {
  // P-256 has broad TLS 1.3 support, including the Bun/Electron platforms.
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: crypto.randomUUID().replaceAll("-", ""), name: "CN=Canopy computer",
    notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 20 * 365.25 * 86400_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" }, keys,
    extensions: [new BasicConstraintsExtension(true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyCertSign)],
  });
  const privateKey = createPrivateKey({ key: Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)), type: "pkcs8", format: "der" }).export({ type: "pkcs8", format: "pem" }).toString();
  return { ...certificateIdentity(certificate.toString("pem")), privateKey };
}
export function computerName(value: string) {
  const name = value.trim();
  if (!name || name.length > 100 || /[\p{Cc}]/u.test(name)) throw new ConnectError("Enter a computer name (1–100 characters)", Code.InvalidArgument);
  return name;
}
export function linkAddress(value: string) {
  try {
    const url = new URL(value);
    if (value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new ConnectError("Enter an HTTPS computer link address without a path", Code.InvalidArgument); }
}
