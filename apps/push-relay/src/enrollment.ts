import type { AttestationVerifier } from "./attestation/index.ts";
import type { ChallengeRequest, CompleteRequest, EnrollmentStore } from "./enrollment-store.ts";
import { jsonObject, jsonString, type JsonValue } from "./json.ts";
import { isExpoToken, isPushPlatform, isSecret, isUuidV4 } from "./protocol.ts";

export interface EnrollmentOptions {
  store: EnrollmentStore;
  verifier: AttestationVerifier;
}

export type EnrollmentRoute = "/v1/enrollment/challenge" | "/v1/enrollment/complete" | "/v1/enrollment/renew";

export function isEnrollmentRoute(path: string): path is EnrollmentRoute {
  return path === "/v1/enrollment/challenge" || path === "/v1/enrollment/complete" || path === "/v1/enrollment/renew";
}

export function issueChallenge({ store, verifier }: EnrollmentOptions, value: JsonValue) {
  const request = parseChallenge(value);

  if (!request || !verifier.supports(request.platform)) return { status: 400 } as const;

  const issued = store.issue(request);

  if (!issued) return { status: 503 } as const;

  const cloudProjectNumber = request.platform === "android" ? verifier.cloudProjectNumber : undefined;

  return { ...issued, ...(cloudProjectNumber !== undefined && { cloudProjectNumber }) };
}

export async function completeChallenge({ store, verifier }: EnrollmentOptions, value: JsonValue) {
  const request = parseComplete(value);

  if (!request) return { status: 400 } as const;

  const reserved = store.reserve(request);

  if (!("challenge" in reserved)) return reserved;

  const { platform, challenge } = reserved;
  let verified: boolean;

  try {
    verified =
      verifier.supports(platform) &&
      (await verifier.verify({
        platform,
        challenge,
        attestation: request.attestation,
        ...(request.keyId !== undefined && { keyId: request.keyId }),
      }));
  } catch {
    store.reject(request.id);

    return { status: 503 } as const;
  }

  if (verified) return store.grant(request);

  store.reject(request.id);

  return { status: 403 } as const;
}

function parseChallenge(value: JsonValue): ChallengeRequest | undefined {
  if (!jsonObject(value) || Object.keys(value).length !== 3) return;

  const { token, platform, binding } = value;

  if (!isExpoToken(token) || !isPushPlatform(platform) || !isSecret(binding)) return;

  return { token, platform, binding };
}

function parseComplete(value: JsonValue): CompleteRequest | undefined {
  if (!jsonObject(value)) return;

  const { id, claim, attestation, keyId } = value;
  const hasKeyId = Object.hasOwn(value, "keyId");

  if (
    Object.keys(value).length !== (hasKeyId ? 4 : 3) ||
    !isUuidV4(id) ||
    !isSecret(claim) ||
    !jsonString(attestation) ||
    attestation.length > 16 * 1024 ||
    !/^[!-~]+$/.test(attestation)
  )
    return;

  if (!hasKeyId) return { id, claim, attestation };

  if (!jsonString(keyId) || keyId.length > 256 || !/^[!-~]+$/.test(keyId)) return;

  return { id, claim, attestation, keyId };
}
