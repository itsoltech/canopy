import { createHmac } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CoreRuntime } from "../core/core-context.ts";
import { decryptSecret, encryptSecret } from "../store/secrets.ts";
import {
  completeEnrollmentBody,
  requestPushChallenge,
  requestPushGrant,
  requestPushRenewal,
  RENEW_WITHIN_MS,
} from "./managed-relay.ts";
import {
  claimPushChallenge,
  registerManagedPush,
  renewPushGrant,
  reservePushEnrollment,
  savePushChallenge,
} from "./managed-store.ts";
import { EXPO_TOKEN, PUSH_ID, PUSH_KEY, type RelayTransport } from "./relay.ts";
import { enqueuePushRevocation } from "./revocation-store.ts";
import { expoTokenHash, pushRegistration, type GrantScope } from "./subscriptions.ts";

export type ManagedPushOptions = RelayTransport & { secretsKey: Buffer };

function enrollmentRequired() {
  return new ConnectError("Start a new push enrollment and try again.", Code.FailedPrecondition);
}

function scopedDigest(key: Buffer, purpose: string, owner: string, device: string, scope: GrantScope) {
  const frame = JSON.stringify([
    purpose,
    owner,
    device,
    scope.origin,
    scope.platform,
    scope.tokenHash.toString("base64url"),
  ]);

  return createHmac("sha256", key).update(frame).digest();
}

export function pushGrantKey(key: Buffer, owner: string, device: string, scope: GrantScope) {
  return scopedDigest(key, "canopy/mobile-push/grant/v1", owner, device, scope);
}

export async function beginManagedMobilePush(
  runtime: CoreRuntime,
  owner: string,
  options: ManagedPushOptions,
  device: string,
  { expoToken: token }: ui.BeginManagedMobilePushRequest,
  signal: AbortSignal,
) {
  if (!EXPO_TOKEN.test(token)) throw new ConnectError("Invalid push registration", Code.InvalidArgument);
  const { origin, secretsKey } = options;
  const tokenHash = expoTokenHash(token);
  const input = { origin, tokenHash, encryptedToken: encryptSecret(secretsKey, token) };
  let state = await runtime.runPromise(reservePushEnrollment(owner, device, input), { signal });

  if (state?.kind === "grant") {
    const { grant, platform } = state;
    let refreshGrantId = grant.reattest_due ? grant.id : undefined;
    let rejectedGrantId: string | undefined;

    if (!refreshGrantId && new Date(grant.expires_at).getTime() <= Date.now() + RENEW_WITHIN_MS) {
      const key = pushGrantKey(secretsKey, owner, device, { origin, platform, tokenHash });
      const bearer = decryptSecret(key, grant.encrypted_bearer);
      const renewal = await requestPushRenewal(options, bearer, signal).catch(() => null);

      if (renewal) {
        if (!(await runtime.runPromise(renewPushGrant(owner, device, grant.id, renewal), { signal })))
          throw enrollmentRequired();

        if (renewal.reattest) refreshGrantId = grant.id;
      } else if (renewal === undefined) rejectedGrantId = grant.id;
    }

    if (refreshGrantId || rejectedGrantId)
      state = await runtime.runPromise(
        reservePushEnrollment(owner, device, { ...input, refreshGrantId, rejectedGrantId }),
        { signal },
      );
  }

  if (!state) throw new ConnectError("Mobile device is unavailable", Code.Unauthenticated);

  if (state.kind === "grant") return create(ui.BeginManagedMobilePushResponseSchema);
  const { platform, requestId, refreshExistingGrant } = state;

  const binding = scopedDigest(secretsKey, "canopy/mobile-push/binding/v1", owner, device, {
    origin,
    platform,
    tokenHash,
  });

  const reply = await requestPushChallenge(options, platform, token, binding.toString("base64url"), signal).catch(
    (error) => {
      if (!refreshExistingGrant) throw error;
    },
  );

  if (!reply) return create(ui.BeginManagedMobilePushResponseSchema);
  const claim = encryptSecret(secretsKey, reply.claim);
  const saved = await runtime.runPromise(savePushChallenge(owner, device, requestId, reply.id, claim), { signal });

  if (!saved) throw enrollmentRequired();

  return create(ui.BeginManagedMobilePushResponseSchema, {
    enrollmentId: reply.id,
    challenge: reply.challenge,
    androidCloudProjectNumber: reply.cloudProjectNumber ?? "",
    refreshExistingGrant,
  });
}

export async function completeManagedMobilePush(
  runtime: CoreRuntime,
  owner: string,
  options: ManagedPushOptions,
  device: string,
  request: ui.CompleteManagedMobilePushRequest,
  signal: AbortSignal,
) {
  const { enrollmentId, attestation, keyId, previewKey } = request;

  if (
    !PUSH_ID.test(enrollmentId) ||
    !PUSH_KEY.test(previewKey) ||
    attestation.length > 16 * 1024 ||
    !/^[!-~]+$/.test(attestation) ||
    keyId.length > 256 ||
    (keyId && !/^[!-~]+$/.test(keyId))
  )
    throw new ConnectError("Invalid push attestation", Code.InvalidArgument);
  const { origin, secretsKey } = options;
  const pending = await runtime.runPromise(claimPushChallenge(owner, device, origin, enrollmentId), { signal });

  if (!pending) throw enrollmentRequired();

  if ((pending.platform === "ios") !== Boolean(keyId))
    throw new ConnectError("Invalid push attestation", Code.InvalidArgument);
  const claim = decryptSecret(secretsKey, pending.encrypted_claim);
  const token = decryptSecret(secretsKey, pending.encrypted_token);
  const scope = { origin, platform: pending.platform, tokenHash: Buffer.from(pending.expo_token_hash) };

  if (!expoTokenHash(token).equals(scope.tokenHash)) throw enrollmentRequired();
  const body = completeEnrollmentBody(enrollmentId, attestation, keyId, claim);
  const grant = await requestPushGrant(options, body, signal);
  const key = pushGrantKey(secretsKey, owner, device, scope);
  const bearer = encryptSecret(key, grant.bearer);

  const stored = await runtime.runPromise(
    registerManagedPush(
      owner,
      device,
      {
        ...scope,
        requestId: pending.request_id,
        bearer,
        expiresAtMs: grant.expiresAtMs,
      },
      pushRegistration(secretsKey, token, previewKey),
    ),
  );

  if (!stored) {
    await runtime.runPromise(enqueuePushRevocation(owner, device, scope, bearer));
    throw enrollmentRequired();
  }

  return create(ui.MobileOperationResponseSchema);
}
