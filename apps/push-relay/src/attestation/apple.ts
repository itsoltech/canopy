import { createHash, X509Certificate } from "node:crypto";
import {
  BasicConstraintsExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  X509Certificate as ParsedCertificate,
} from "@peculiar/x509";
import cbor from "cbor";
import { jsonString } from "../json.ts";
import type { AttestationInput } from "./index.ts";

// https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
const root = new X509Certificate(`-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`);

const nonceOid = "1.2.840.113635.100.8.2";
const productionAaguid = Buffer.from("appattest\0\0\0\0\0\0\0");
const developmentAaguids = [Buffer.from("appattestsandbox"), Buffer.from("appattestdevelop")];
const cborOptions = { max_depth: 8, preferMap: true, preventDuplicateKeys: true };

interface AppleIdentity {
  teamId: string;
  bundleId: string;
  development: boolean;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest();
}

function decodeBase64(value: string): Buffer | undefined {
  const bytes = Buffer.from(value, "base64");

  return bytes.toString("base64") === value ? bytes : undefined;
}

function validAt(certificate: X509Certificate, now: number) {
  return Date.parse(certificate.validFrom) <= now && now <= Date.parse(certificate.validTo);
}

function certNonce(leaf: ParsedCertificate): Buffer | undefined {
  const [extension, duplicate] = leaf.getExtensions(nonceOid);

  if (!extension || duplicate) return;

  // DER SEQUENCE containing EXPLICIT [1] containing the 32-byte OCTET STRING.
  const der = Buffer.from(extension.value);

  if (der.length === 38 && der.subarray(0, 6).equals(Buffer.from([0x30, 36, 0xa1, 34, 0x04, 32])))
    return der.subarray(6);

  return undefined;
}

function allowsKeyUsage(certificate: ParsedCertificate, usage: KeyUsageFlags) {
  if (
    certificate.extensions.some(
      (extension) =>
        extension.critical &&
        !(extension instanceof BasicConstraintsExtension) &&
        !(extension instanceof KeyUsagesExtension),
    )
  )
    return false;

  const [keyUsage, duplicateUsage] = certificate.getExtensions(KeyUsagesExtension);
  const [constraints, duplicateConstraints] = certificate.getExtensions(BasicConstraintsExtension);

  return !!constraints && !duplicateConstraints && !duplicateUsage && !!keyUsage && (keyUsage.usages & usage) !== 0;
}

function credentialCertificate(chain: readonly Buffer[], now: number) {
  const [leafBytes, intermediateBytes] = chain;

  if (chain.length !== 2 || !Buffer.isBuffer(leafBytes) || !Buffer.isBuffer(intermediateBytes)) return;

  const leaf = new X509Certificate(leafBytes);
  const intermediate = new X509Certificate(intermediateBytes);

  if (
    !leaf.raw.equals(leafBytes) ||
    !intermediate.raw.equals(intermediateBytes) ||
    leaf.ca ||
    !intermediate.ca ||
    !validAt(leaf, now) ||
    !validAt(intermediate, now) ||
    !validAt(root, now) ||
    !intermediate.checkIssued(root) ||
    !intermediate.verify(root.publicKey) ||
    !leaf.checkIssued(intermediate) ||
    !leaf.verify(intermediate.publicKey)
  )
    return;

  if (!allowsKeyUsage(new ParsedCertificate(Uint8Array.from(intermediateBytes)), KeyUsageFlags.keyCertSign)) return;

  return leaf;
}

function checkCredentialKey(authData: Buffer, x: Buffer, y: Buffer, development: boolean) {
  const items = cbor.decodeAllSync(authData.subarray(87), cborOptions);
  const [key, extensions] = items;

  if (items.length > 2 || !(key instanceof Map) || key.get(1) !== 2 || key.get(3) !== -7 || key.get(-1) !== 1)
    return false;

  const xCoordinate = key.get(-2);
  const yCoordinate = key.get(-3);

  if (
    !Buffer.isBuffer(xCoordinate) ||
    !xCoordinate.equals(x) ||
    !Buffer.isBuffer(yCoordinate) ||
    !yCoordinate.equals(y)
  )
    return false;

  // Apple added these extensions after the original format. Older iOS attestations end at the COSE key.
  if (items.length === 1) return true;

  if (!(extensions instanceof Map)) return false;

  const category = extensions.get("apple_validation_category_01");
  const version = extensions.get("apple_bundle_version_01");

  if (!Buffer.isBuffer(category) || category.length !== 4 || !jsonString(version) || !version.length) return false;

  const validationCategory = category.readUInt32LE();

  return development ? validationCategory === 3 : validationCategory === 2 || validationCategory === 4;
}

export function createAppleVerifier(identity: AppleIdentity, now = Date.now) {
  const appIdHash = sha256(`${identity.teamId}.${identity.bundleId}`);

  return (input: AttestationInput): boolean => {
    const keyId = input.keyId && decodeBase64(input.keyId);
    const bytes = decodeBase64(input.attestation);

    if (!keyId || keyId.length !== 32 || !bytes?.length) return false;

    const attestation = cbor.decodeFirstSync(bytes, cborOptions);

    if (!(attestation instanceof Map) || attestation.get("fmt") !== "apple-appattest") return false;

    const statement = attestation.get("attStmt");
    const authData = attestation.get("authData");

    if (!(statement instanceof Map) || !Buffer.isBuffer(authData) || authData.length < 87) return false;

    const chain = statement.get("x5c");
    const receipt = statement.get("receipt");

    if (!Array.isArray(chain) || !Buffer.isBuffer(receipt) || !receipt.length) return false;

    if (
      !authData.subarray(0, 32).equals(appIdHash) ||
      !(authData.readUInt8(32) & 0x40) ||
      authData.readUInt32BE(33) !== 0 ||
      authData.readUInt16BE(53) !== 32 ||
      !authData.subarray(55, 87).equals(keyId)
    )
      return false;

    const aaguid = authData.subarray(37, 53);

    const validEnvironment = identity.development
      ? developmentAaguids.some((candidate) => aaguid.equals(candidate))
      : aaguid.equals(productionAaguid);

    if (!validEnvironment) return false;

    const leaf = credentialCertificate(chain, now());

    if (!leaf) return false;

    // Expo hashes the exact UTF-8 challenge string before passing it to DCAppAttestService.
    const nonce = sha256(Buffer.concat([authData, sha256(input.challenge)]));
    const certificate = new ParsedCertificate(leaf.raw);

    if (!allowsKeyUsage(certificate, KeyUsageFlags.digitalSignature) || !certNonce(certificate)?.equals(nonce))
      return false;

    const key = leaf.publicKey.export({ format: "jwk" });

    if (key.kty !== "EC" || key.crv !== "P-256" || !key.x || !key.y) return false;

    const x = Buffer.from(key.x, "base64url");
    const y = Buffer.from(key.y, "base64url");
    const publicKeyPoint = Buffer.concat([Buffer.from([0x04]), x, y]);

    return sha256(publicKeyPoint).equals(keyId) && checkCredentialKey(authData, x, y, identity.development);
  };
}
