import { jsonArray, jsonObject, jsonString, type JsonValue } from "../json.ts";
import { GoogleAccessToken, postToGoogle, type ServiceAccount } from "./google-auth.ts";
import type { AttestationInput } from "./index.ts";

const freshnessMs = 2 * 60_000;
const futureSkewMs = 5_000;

interface AndroidIdentity {
  packageName: string;
  signingCerts: ReadonlySet<string>;
  allowUnrecognized: boolean;
}

function matchesSigningCert(value: JsonValue, trusted: ReadonlySet<string>) {
  if (!jsonString(value) || !/^[A-Za-z0-9_-]{43}=?$/.test(value)) return false;

  const fingerprint = Buffer.from(value, "base64url");

  return fingerprint.toString("base64url") === value.replace(/=$/, "") && trusted.has(fingerprint.toString("hex"));
}

function verifyVerdict(payload: JsonValue | undefined, identity: AndroidIdentity, challenge: string, now: number) {
  // Play includes testingDetails when it overrides verdicts for a Play Console tester.
  if (!jsonObject(payload) || payload["testingDetails"] !== undefined) return false;

  const { requestDetails, appIntegrity, deviceIntegrity } = payload;

  if (!jsonObject(requestDetails) || !jsonObject(appIntegrity) || !jsonObject(deviceIntegrity)) return false;

  const { requestPackageName, requestHash, nonce, timestampMillis } = requestDetails;

  if (
    requestPackageName !== identity.packageName ||
    requestHash !== challenge ||
    nonce !== undefined ||
    !jsonString(timestampMillis) ||
    !/^\d{13}$/.test(timestampMillis)
  )
    return false;

  const age = now - Number(timestampMillis);

  if (age > freshnessMs || age < -futureSkewMs) return false;

  const { appRecognitionVerdict, packageName, versionCode, certificateSha256Digest } = appIntegrity;

  if (
    packageName !== identity.packageName ||
    !jsonString(versionCode) ||
    !/^[1-9]\d{0,18}$/.test(versionCode) ||
    (appRecognitionVerdict !== "PLAY_RECOGNIZED" &&
      !(identity.allowUnrecognized && appRecognitionVerdict === "UNRECOGNIZED_VERSION")) ||
    !jsonArray(certificateSha256Digest) ||
    !certificateSha256Digest.length ||
    !certificateSha256Digest.every((digest) => matchesSigningCert(digest, identity.signingCerts))
  )
    return false;

  const deviceVerdicts = deviceIntegrity["deviceRecognitionVerdict"];

  return (
    jsonArray(deviceVerdicts) && deviceVerdicts.every(jsonString) && deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY")
  );
}

export function createPlayIntegrityVerifier(
  identity: AndroidIdentity,
  account: ServiceAccount,
  fetcher: (url: string, init: BunFetchRequestInit) => Promise<Response> = fetch,
  now = Date.now,
) {
  const oauth = new GoogleAccessToken(account, fetcher, now);
  const url = `https://playintegrity.googleapis.com/v1/${encodeURIComponent(identity.packageName)}:decodeIntegrityToken`;

  return async (input: AttestationInput): Promise<boolean> => {
    const accessToken = await oauth.get();

    if (!accessToken) return false;

    const response = await postToGoogle(fetcher, url, {
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ integrityToken: input.attestation }),
    });

    return verifyVerdict(response?.["tokenPayloadExternal"], identity, input.challenge, now());
  };
}
