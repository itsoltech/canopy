import { constants, timingSafeEqual } from "node:crypto";
import { pushScope, type EnrollmentStore, type Grant } from "./enrollment-store.ts";
import {
  completeChallenge,
  isEnrollmentRoute,
  issueChallenge,
  type EnrollmentOptions,
  type EnrollmentRoute,
} from "./enrollment.ts";
import { Expo, type ExpoFetch } from "./expo.ts";
import { jsonObject, readJson, type JsonObject, type JsonValue } from "./json.ts";
import { Limits } from "./limits.ts";
import { digest, isSecret, parseDismissal, parsePush, parseReceipt } from "./protocol.ts";

const requestBytes = 4 * 1024;
const completeBytes = 32 * 1024;
const requestTimeoutMs = 3_000;
const jsonType = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/i;
const revokePath = "/v1/enrollment/revoke";

interface RelayOptions {
  hostname: string;
  port: number;
  cert: string;
  key: string;
  digests?: readonly Buffer[];
  enrollment?: EnrollmentOptions | { store: EnrollmentStore; verifier?: never };
  expoAccessToken: string;
}

type Identity = { digest: string; grant: Grant | null };

function reply(status: number) {
  const headers = new Headers({ "cache-control": "no-store" });

  if (status === 401) headers.set("www-authenticate", "Bearer");

  if (status === 405) headers.set("allow", "POST");

  if (status === 429 || status === 503) headers.set("retry-after", "1");

  return new Response(null, { status, headers });
}

function bearerHash(request: Request) {
  const credential = bearer.exec(request.headers.get("authorization") ?? "")?.[1];

  return isSecret(credential) ? digest(credential) : null;
}

function identify(request: Request, digests: readonly Buffer[], enrollment?: EnrollmentOptions): Identity | null {
  const hash = bearerHash(request);

  if (!hash) return null;

  const bytes = Buffer.from(hash, "hex");
  let manual = false;

  for (const candidate of digests) {
    if (timingSafeEqual(candidate, bytes)) manual = true;
  }

  if (manual) return { digest: hash, grant: null };

  const grant = enrollment?.store.find(hash);

  return grant && enrollment?.verifier.supports(grant.platform) ? { digest: hash, grant } : null;
}

async function readBody(request: Request, bytes: number) {
  if (request.method !== "POST") return { status: 405 };

  if (!jsonType.test(request.headers.get("content-type") ?? "") || request.headers.has("content-encoding"))
    return { status: 415 };

  return readJson(request, bytes, AbortSignal.timeout(requestTimeoutMs));
}

function emptyObject(value: JsonValue) {
  return jsonObject(value) && Object.keys(value).length === 0;
}

async function handleRevoke(request: Request, hash: string, store?: EnrollmentStore) {
  const body = await readBody(request, requestBytes);

  if ("status" in body) return reply(body.status);

  if (!emptyObject(body.value)) return reply(400);

  store?.revoke(hash);

  return reply(204);
}

async function handleEnrollment(
  request: Request,
  path: EnrollmentRoute,
  enrollment: EnrollmentOptions,
  digests: readonly Buffer[],
) {
  const identity = path === "/v1/enrollment/renew" ? identify(request, digests, enrollment) : null;

  if (path === "/v1/enrollment/renew" && !identity?.grant) return reply(401);

  const body = await readBody(request, path === "/v1/enrollment/complete" ? completeBytes : requestBytes);

  if ("status" in body) return reply(body.status);

  if (identity?.grant) {
    if (!emptyObject(body.value)) return reply(400);

    const renewed = enrollment.store.renew(identity.digest);

    return renewed ? jsonResponse(renewed) : reply(401);
  }

  const result =
    path === "/v1/enrollment/challenge"
      ? issueChallenge(enrollment, body.value)
      : await completeChallenge(enrollment, body.value);

  return "status" in result ? reply(result.status) : jsonResponse({ ...result });
}

async function handleDelivery(
  path: string,
  body: JsonValue,
  identity: Identity,
  expo: Expo,
  enrollment?: EnrollmentOptions,
) {
  // The grant can rotate or expire while waiting for the request body.
  const store = enrollment?.store;
  const grant = identity.grant ? store?.find(identity.digest) : undefined;

  if (identity.grant && !grant) return reply(401);

  if (path === "/v1/receipt") {
    const ticketId = parseReceipt(body);

    if (ticketId === undefined) return reply(400);

    if (grant && !store?.hasTicket(grant, ticketId)) return reply(404);

    return reply(await expo.receipt(ticketId));
  }

  if (path === "/v1/dismiss") {
    const dismissal = parseDismissal(body);

    if (!dismissal) return reply(400);

    if (grant && grant.scope !== pushScope(dismissal)) return reply(403);

    // Dismissals keep no ticket: the gateway does not check their receipts.
    const ticket = await expo.dismiss(dismissal);

    return reply(ticket.status === 202 ? 204 : ticket.status);
  }

  const push = parsePush(body);

  if (!push) return reply(400);

  if (grant && grant.scope !== pushScope(push)) return reply(403);

  if (grant && !store?.canSend(grant)) return reply(503);

  const ticket = await expo.send(push);

  if (ticket.status !== 202) return reply(ticket.status);

  if (grant && !store?.rememberTicket(grant, ticket.ticketId)) return reply(503);

  return jsonResponse({ ticketId: ticket.ticketId }, 202);
}

function jsonResponse(value: JsonObject, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export function serveRelay(options: RelayOptions, fetcher: ExpoFetch = fetch) {
  if (!options.cert.trim() || !options.key.trim())
    throw new Error("The push relay requires a TLS certificate and key.");

  const { store, verifier } = options.enrollment ?? {};
  const { digests = [] } = options;
  const enrollment = store && verifier ? { store, verifier } : undefined;

  if (digests.length === 0 && !store) throw new Error("The push relay requires gateway digests or enrollment.");

  const manualLimits = new Limits(
    { requestsPerSecond: 2, burst: 20, concurrent: 4 },
    { requestsPerSecond: 256, burst: 2560, concurrent: 32 },
    128,
  );

  const deliveryLimits = new Limits(
    { requestsPerSecond: 1, burst: 10, concurrent: 4 },
    { requestsPerSecond: 100, burst: 128, concurrent: 32 },
    4096,
  );

  const enrollmentLimits = new Limits(
    { requestsPerSecond: 1, burst: 20, concurrent: 3 },
    { requestsPerSecond: 8, burst: 40, concurrent: 8 },
    1024,
  );

  const revocationLimits = new Limits(
    { requestsPerSecond: 2, burst: 20, concurrent: 4 },
    { requestsPerSecond: 40, burst: 80, concurrent: 24 },
    1024,
  );

  const expo = new Expo(options.expoAccessToken, fetcher);

  return Bun.serve({
    hostname: options.hostname,
    port: options.port,
    tls: {
      cert: options.cert,
      key: options.key,
      // Bun.serve exposes the protocol mask through secureOptions.
      secureOptions: constants.SSL_OP_NO_TLSv1 | constants.SSL_OP_NO_TLSv1_1 | constants.SSL_OP_NO_TLSv1_2,
    },
    development: false,
    maxRequestBodySize: enrollment ? completeBytes : requestBytes,
    idleTimeout: 15,
    error: () => reply(503),
    fetch: async (request, server) => {
      const { pathname, search } = new URL(request.url);

      if (search) return reply(404);

      if (pathname === revokePath) {
        const hash = bearerHash(request);

        if (!hash) return reply(401);

        const peer = server.requestIP(request);

        if (!peer) return reply(503);

        const admission = revocationLimits.admit(peer.address);

        if ("status" in admission) return reply(admission.status);

        try {
          return await handleRevoke(request, hash, store);
        } finally {
          admission.release();
        }
      }

      if (isEnrollmentRoute(pathname)) {
        if (!enrollment) return reply(404);

        const peer = server.requestIP(request);

        if (!peer) return reply(503);

        const admission = enrollmentLimits.admit(peer.address);

        if ("status" in admission) return reply(admission.status);

        try {
          return await handleEnrollment(request, pathname, enrollment, digests);
        } finally {
          admission.release();
        }
      }

      const identity = identify(request, digests, enrollment);

      if (!identity) return reply(401);

      const admission = identity.grant
        ? deliveryLimits.admit(identity.grant.scope)
        : manualLimits.admit(identity.digest);

      if ("status" in admission) return reply(admission.status);

      try {
        if (pathname !== "/v1/push" && pathname !== "/v1/receipt" && pathname !== "/v1/dismiss") return reply(404);

        const body = await readBody(request, requestBytes);

        return "status" in body
          ? reply(body.status)
          : await handleDelivery(pathname, body.value, identity, expo, enrollment);
      } finally {
        admission.release();
      }
    },
  });
}
