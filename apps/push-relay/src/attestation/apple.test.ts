import { expect, test } from "bun:test";
import cbor from "cbor";
import { createAppleVerifier } from "./apple.ts";
import development from "./fixtures/attestation-development.json";
import production from "./fixtures/attestation-production.json";
import { attestationFromEnv, type AttestationInput } from "./index.ts";

// Public sample attestations from the fixture author's MIT-licensed test suite.
// https://github.com/uebelack/node-app-attest/tree/493d029e2d6a7e6bc8b4e4d032b01fb204b85c39/test/fixtures
const identity = { teamId: "V8H6LQ9448", bundleId: "io.uebelacker.AppAttestExample", development: false };
const validTime = () => Date.parse("2024-06-01T00:00:00Z");

function inputFor(fixture: typeof production): AttestationInput {
  return { ...fixture, platform: "ios", challenge: Buffer.from(fixture.challenge, "base64").toString("utf8") };
}

test("App Attest binds the pinned Apple chain to exact challenge bytes, App ID and key ID", () => {
  const input = inputFor(production);
  const verify = createAppleVerifier(identity, validTime);

  expect(verify(input)).toBe(true);
  expect(verify({ ...input, challenge: production.challenge })).toBe(false);
  expect(verify({ ...input, challenge: input.challenge + "\n" })).toBe(false);
  expect(verify({ ...input, keyId: development.keyId })).toBe(false);
  expect(createAppleVerifier({ ...identity, bundleId: "io.example.wrong" }, validTime)(input)).toBe(false);
  expect(createAppleVerifier({ ...identity, teamId: "1234567890" }, validTime)(input)).toBe(false);
  expect(createAppleVerifier(identity, () => Date.parse("2025-01-01T00:00:00Z"))(input)).toBe(false);

  const bytes = Buffer.from(input.attestation, "base64");
  const decoded = cbor.decodeFirstSync(bytes);
  const [leaf] = decoded.attStmt.x5c;
  const leafStart = bytes.indexOf(leaf);

  expect(leafStart).toBeGreaterThanOrEqual(0);

  const last = leafStart + leaf.length - 1;

  bytes.writeUInt8(bytes.readUInt8(last) ^ 1, last);

  expect(verify({ ...input, attestation: bytes.toString("base64") })).toBe(false);
});

test("App Attest keeps sandbox and production separate", () => {
  const verifyProduction = createAppleVerifier(identity, validTime);
  const verifyDevelopment = createAppleVerifier({ ...identity, development: true }, validTime);

  expect(verifyProduction(inputFor(development))).toBe(false);
  expect(verifyDevelopment(inputFor(development))).toBe(true);
  expect(verifyDevelopment(inputFor(production))).toBe(false);
});

test("Malformed Apple attestation fails closed at the verifier boundary", async () => {
  const verifier = attestationFromEnv({
    CANOPY_PUSH_APPLE_TEAM_ID: identity.teamId,
    CANOPY_PUSH_APPLE_BUNDLE_ID: identity.bundleId,
  });

  expect(verifier?.supports("ios")).toBe(true);
  expect(verifier?.supports("android")).toBe(false);
  expect(
    await verifier?.verify({
      platform: "ios",
      challenge: Buffer.alloc(32).toString("base64url"),
      keyId: production.keyId,
      attestation: Buffer.from([0xff]).toString("base64"),
    }),
  ).toBe(false);
});
