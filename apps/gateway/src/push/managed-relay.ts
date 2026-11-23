import { Code, ConnectError } from "@connectrpc/connect";
import { Option, Schema } from "effect";
import type { GatewayRole } from "../role.ts";
import { normalizedRelayOrigin, postPushRelay, PUSH_ID, PUSH_KEY, type RelayTransport } from "./relay.ts";
import type { PushPlatform } from "./subscriptions.ts";

export const DEFAULT_MANAGED_RELAY_ORIGIN = "https://notifications-relay.canopy.itsol.tech";
const DAY_MS = 86_400_000;
const MAX_REQUEST_BYTES = 32 * 1024;

export const RENEW_WITHIN_MS = 7 * DAY_MS;

export function managedRelayOrigin(value: string) {
  const origin = /^https:\/\/[^/?#@\\\s]+\/?$/i.test(value) && normalizedRelayOrigin(value);

  if (!origin) throw new Error("CANOPY_MANAGED_PUSH_RELAY_ORIGIN must be an HTTPS origin");

  return origin;
}

export function configuredManagedRelayOrigin(role: GatewayRole, env: Readonly<Record<string, string | undefined>>) {
  const value =
    env["CANOPY_MANAGED_PUSH_RELAY_ORIGIN"] ?? (role === "desktop" ? DEFAULT_MANAGED_RELAY_ORIGIN : undefined);

  return value ? managedRelayOrigin(value) : undefined;
}

function relayUnavailable() {
  return new ConnectError("Could not contact the managed push relay. Try again.", Code.Unavailable);
}

const decodeOptions = { onExcessProperty: "error" } as const;
const Secret = Schema.String.check(Schema.isPattern(PUSH_KEY));

const readChallenge = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(PUSH_ID)),
      challenge: Secret,
      claim: Secret,
      cloudProjectNumber: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,19}$/))),
    }),
  ),
  decodeOptions,
);

const readGrant = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ bearer: Secret, expiresAtMs: Schema.Number })),
  decodeOptions,
);

const readRenewal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ expiresAtMs: Schema.Number, reattest: Schema.optionalKey(Schema.Boolean) })),
  decodeOptions,
);

function validExpiry(expiresAtMs: number) {
  const now = Date.now();

  return Number.isSafeInteger(expiresAtMs) && expiresAtMs > now && expiresAtMs <= now + 36 * DAY_MS;
}

async function postEnrollment(
  options: RelayTransport,
  path: string,
  body: string,
  signal: AbortSignal,
  requestOptions?: { bearer?: string; timeoutMs?: number },
) {
  try {
    return await postPushRelay(options, path, body, signal, requestOptions);
  } catch {
    throw relayUnavailable();
  }
}

export async function requestPushChallenge(
  options: RelayTransport,
  platform: PushPlatform,
  token: string,
  binding: string,
  signal: AbortSignal,
) {
  const result = await postEnrollment(
    options,
    "/v1/enrollment/challenge",
    JSON.stringify({ platform, token, binding }),
    signal,
  );

  const value = result.status === 200 ? Option.getOrUndefined(readChallenge(result.body)) : undefined;

  if (!value || (platform === "android") !== (value.cloudProjectNumber !== undefined)) throw relayUnavailable();

  return value;
}

export function completeEnrollmentBody(id: string, attestation: string, keyId: string, claim: string) {
  const value = JSON.stringify({ id, claim, attestation, ...(keyId && { keyId }) });

  if (Buffer.byteLength(value) > MAX_REQUEST_BYTES)
    throw new ConnectError("Invalid push attestation", Code.InvalidArgument);

  return value;
}

export async function requestPushGrant(options: RelayTransport, body: string, signal: AbortSignal) {
  // Play Integrity may fetch a Google OAuth token before decoding the evidence.
  const result = await postEnrollment(options, "/v1/enrollment/complete", body, signal, { timeoutMs: 10_000 });

  if ([400, 401, 403, 404, 409, 410, 422].includes(result.status))
    throw new ConnectError("Push attestation was rejected. Try again.", Code.FailedPrecondition);
  const value = result.status === 200 ? Option.getOrUndefined(readGrant(result.body)) : undefined;

  if (!value || !validExpiry(value.expiresAtMs)) throw relayUnavailable();

  return value;
}

export async function requestPushRenewal(options: RelayTransport, bearer: string, signal: AbortSignal) {
  const result = await postEnrollment(options, "/v1/enrollment/renew", "{}", signal, { bearer });

  if (result.status === 401 || result.status === 403) return;
  const value = result.status === 200 ? Option.getOrUndefined(readRenewal(result.body)) : undefined;

  if (!value || !validExpiry(value.expiresAtMs)) throw relayUnavailable();

  return value;
}

export async function revokePushGrant(options: RelayTransport, bearer: string, signal: AbortSignal) {
  const result = await postPushRelay(options, "/v1/enrollment/revoke", "{}", signal, { bearer });

  return result.status === 204 || result.status === 401;
}
