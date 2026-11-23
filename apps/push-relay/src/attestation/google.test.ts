import { expect, test } from "bun:test";
import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { createPlayIntegrityVerifier } from "./google.ts";
import type { AttestationInput } from "./index.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const account = { email: "relay@example.invalid", key: keys.privateKey };
const cert = Buffer.alloc(32, 0x41);

const identity = {
  packageName: "tech.example.canopy",
  signingCerts: new Set([cert.toString("hex")]),
  allowUnrecognized: false,
};

const now = Date.parse("2026-06-01T00:00:00Z");

const input: AttestationInput = {
  platform: "android",
  challenge: Buffer.alloc(32, 0x53).toString("base64url"),
  attestation: "opaque-token",
};

const oauthUrl = "https://oauth2.googleapis.com/token";
const decodeUrl = "https://playintegrity.googleapis.com/v1/tech.example.canopy:decodeIntegrityToken";
const tokenReply = { token_type: "Bearer", access_token: "test-access-token", expires_in: 3_599 };

function playPayload() {
  return {
    requestDetails: {
      requestPackageName: identity.packageName,
      requestHash: input.challenge,
      timestampMillis: String(now),
    },
    appIntegrity: {
      appRecognitionVerdict: "PLAY_RECOGNIZED",
      packageName: identity.packageName,
      versionCode: "22",
      certificateSha256Digest: [cert.toString("base64url") + "="],
    },
    deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY", "MEETS_DEVICE_INTEGRITY"] },
    accountDetails: { appLicensingVerdict: "UNLICENSED" },
  };
}

type TestVerdict = ReturnType<typeof playPayload> & { testingDetails?: { isTestingResponse: boolean } };

function withGooglePayload(payload: TestVerdict, allowUnrecognized = false) {
  return createPlayIntegrityVerifier(
    { ...identity, allowUnrecognized },
    account,
    async (url) => Response.json(url === oauthUrl ? tokenReply : { tokenPayloadExternal: payload }),
    () => now,
  );
}

test("Standard Play Integrity decodes via authenticated, fixed HTTPS endpoints", async () => {
  const requests: { url: string; options: BunFetchRequestInit }[] = [];

  const verify = createPlayIntegrityVerifier(
    identity,
    account,
    async (url, options) => {
      requests.push({ url, options });

      return Response.json(url === oauthUrl ? tokenReply : { tokenPayloadExternal: playPayload() });
    },
    () => now,
  );

  // Concurrent verification shares the service-account refresh.
  expect(await Promise.all([verify(input), verify(input)])).toEqual([true, true]);
  expect(requests.map(({ url }) => url)).toEqual([oauthUrl, decodeUrl, decodeUrl]);

  for (const { options } of requests) {
    expect(options.redirect).toBe("error");
    expect(options.method).toBe("POST");
    expect(options.tls?.rejectUnauthorized).toBe(true);
  }

  const form = requests[0]?.options.body;

  expect(form).toBeInstanceOf(URLSearchParams);

  if (!(form instanceof URLSearchParams)) throw new Error("Expected OAuth form");

  const [header, claims, signature] = (form.get("assertion") ?? "").split(".");

  if (!header || !claims || !signature) throw new Error("Expected OAuth assertion");

  expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
  expect(JSON.parse(Buffer.from(claims, "base64url").toString("utf8"))).toEqual({
    iss: account.email,
    scope: "https://www.googleapis.com/auth/playintegrity",
    aud: oauthUrl,
    iat: now / 1_000,
    exp: now / 1_000 + 3_600,
  });
  expect(
    verifySignature(
      "RSA-SHA256",
      Buffer.from(`${header}.${claims}`),
      keys.publicKey,
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);

  for (const request of requests.slice(1)) {
    expect(new Headers(request.options.headers).get("authorization")).toBe("Bearer test-access-token");
    expect(request.options.body).toBe(JSON.stringify({ integrityToken: input.attestation }));
  }
});

test.each([
  [
    "Play Console test verdict",
    (p) => {
      p.testingDetails = { isTestingResponse: true };
    },
  ],
  [
    "different challenge",
    (p) => {
      p.requestDetails.requestHash = input.challenge.toLowerCase();
    },
  ],
  [
    "different request package",
    (p) => {
      p.requestDetails.requestPackageName = "tech.example.other";
    },
  ],
  [
    "different signing package",
    (p) => {
      p.appIntegrity.packageName = "tech.example.other";
    },
  ],
  [
    "expired verdict",
    (p) => {
      p.requestDetails.timestampMillis = String(now - 120_001);
    },
  ],
  [
    "future verdict",
    (p) => {
      p.requestDetails.timestampMillis = String(now + 5_001);
    },
  ],
  [
    "untrusted co-signer",
    (p) => {
      p.appIntegrity.certificateSha256Digest.push(Buffer.alloc(32).toString("base64url"));
    },
  ],
  [
    "missing signing certificate",
    (p) => {
      p.appIntegrity.certificateSha256Digest = [];
    },
  ],
  [
    "only basic or virtual device integrity",
    (p) => {
      p.deviceIntegrity.deviceRecognitionVerdict = ["MEETS_BASIC_INTEGRITY", "MEETS_VIRTUAL_INTEGRITY"];
    },
  ],
  [
    "unevaluated application",
    (p) => {
      p.appIntegrity.appRecognitionVerdict = "UNEVALUATED";
    },
  ],
] satisfies [string, (payload: TestVerdict) => void][])("rejects %s under both Play policies", async (_, tamper) => {
  const payload = playPayload();

  tamper(payload);

  expect(await withGooglePayload(payload)(input)).toBe(false);
  expect(await withGooglePayload(payload, true)(input)).toBe(false);
});

test("sideload policy admits only evaluated APKs signed by an allowed certificate", async () => {
  const payload = playPayload();

  payload.appIntegrity.appRecognitionVerdict = "UNRECOGNIZED_VERSION";

  expect(await withGooglePayload(payload)(input)).toBe(false);
  expect(await withGooglePayload(payload, true)(input)).toBe(true);

  payload.appIntegrity.versionCode = "";

  expect(await withGooglePayload(payload, true)(input)).toBe(false);
});

test("rejects a Google redirect response even if it carries an otherwise valid payload", async () => {
  const verify = createPlayIntegrityVerifier(
    identity,
    account,
    async (url) => {
      if (url === oauthUrl) return Response.json(tokenReply);

      return Response.json(
        { tokenPayloadExternal: playPayload() },
        {
          status: 307,
          headers: { location: "https://example.invalid/redirect" },
        },
      );
    },
    () => now,
  );

  expect(await verify(input)).toBe(false);
});
