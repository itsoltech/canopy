import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import type { AttestationVerifier } from "./attestation/index.ts";
import { enrollmentSchema } from "./enrollment-schema.ts";
import { EnrollmentStore, pushScope, type ChallengeRequest, type CompleteRequest } from "./enrollment-store.ts";
import type { ExpoFetch } from "./expo.ts";
import { jsonObject, readJson, type JsonValue } from "./json.ts";
import { digest, isSecret, isUuidV4, type PushTarget } from "./protocol.ts";
import { serveRelay } from "./server.ts";

const gatewayA = randomBytes(32).toString("base64url");
const gatewayB = randomBytes(32).toString("base64url");
const expoAccessToken = "fake-expo-token";
const ticketId = randomUUID();
const preview = randomBytes(32).toString("base64url");
const push = { token: "ExponentPushToken[abc-DEF_123]", receiptId: randomUUID(), platform: "ios", preview };

let directory: string;
let cert: string;
let key: string;
let relay: ReturnType<typeof serveRelay>;
let managedStore: EnrollmentStore | undefined;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "canopy-push-relay-"));
  const certFile = join(directory, "cert.pem");
  const keyFile = join(directory, "key.pem");

  const generated = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=canopy-test",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    keyFile,
    "-out",
    certFile,
  ]);

  if (generated.exitCode !== 0) throw new Error("Could not generate test TLS certificate.");

  cert = readFileSync(certFile, "utf8");
  key = readFileSync(keyFile, "utf8");
});

afterEach(async () => {
  await relay?.stop(true);

  managedStore?.close();
  managedStore = undefined;
});

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true });
});

function start(provider: ExpoFetch, enrollment?: Parameters<typeof serveRelay>[0]["enrollment"], includeManual = true) {
  const digests = includeManual
    ? [gatewayA, gatewayB].map((credential) => createHash("sha256").update(credential).digest())
    : [];

  relay = serveRelay(
    { hostname: "127.0.0.1", port: 0, cert, key, digests, expoAccessToken, ...(enrollment && { enrollment }) },
    provider,
  );
}

function post(
  path: string,
  body: string | ReadableStream<Uint8Array>,
  credential: string | null = gatewayA,
  options?: BunFetchRequestInit,
) {
  return fetch(new URL(path, relay.url), {
    method: "POST",
    proxy: false,
    signal: AbortSignal.timeout(2_000),
    headers: { "content-type": "application/json", ...(credential && { authorization: `Bearer ${credential}` }) },
    tls: { ca: cert },
    body,
    ...options,
  });
}

function accepted() {
  return Response.json({ data: { status: "ok", id: ticketId } });
}

test("accepts only authenticated requests over verified TLS 1.3", async () => {
  let providerCalls = 0;

  start(async () => {
    providerCalls++;

    return accepted();
  });

  const data = JSON.stringify(push);
  const version = Promise.withResolvers<void>();

  const socket = connect({
    ca: cert,
    host: "127.0.0.1",
    port: relay.url.port ? Number(relay.url.port) : 443,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  });

  socket.once("error", version.reject);
  socket.once("secureConnect", () => {
    socket.destroy();
    version.resolve();
  });

  await expect(version.promise).rejects.toThrow();
  await expect(post("/v1/push", data, gatewayA, { tls: { rejectUnauthorized: true } })).rejects.toThrow();

  const cleartext = new URL("/v1/push", relay.url);
  cleartext.protocol = "http:";

  const insecure = await fetch(cleartext, {
    method: "POST",
    proxy: false,
    signal: AbortSignal.timeout(2_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${gatewayA}` },
    body: data,
  }).catch(() => undefined);

  expect(insecure?.ok ?? false).toBe(false);
  expect((await post("/v1/push", data, randomBytes(32).toString("base64url"))).status).toBe(401);
  expect((await post("/v1/receipt", JSON.stringify({ ticketId }), gatewayA + "=")).status).toBe(401);
  expect(providerCalls).toBe(0);

  const response = await post("/v1/push", data);

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ticketId });
  expect(providerCalls).toBe(1);
});

test("caps and validates JSON and builds platform-specific provider messages", async () => {
  const providerCalls: Parameters<ExpoFetch>[] = [];

  start(async (url, init) => {
    providerCalls.push([url, init]);

    return accepted();
  });

  const invalidPushes = [
    { ...push, body: "Private message" },
    { ...push, platform: "windows" },
    { ...push, receiptId: "not-a-receipt" },
    { ...push, token: "ExpoPushToken[https://example.test/]" },
    { ...push, preview: "A".repeat(39) },
    { ...push, preview: preview + "=" },
    { ...push, preview: "A".repeat(42) + "B" },
    { ...push, preview: "A".repeat(2701) },
  ];

  for (const invalid of invalidPushes) expect((await post("/v1/push", JSON.stringify(invalid))).status).toBe(400);

  expect((await post("/v1/receipt", JSON.stringify({ ticketId: "../../example.test" }))).status).toBe(400);
  expect((await post("/v1/push", " ".repeat(4096) + JSON.stringify(push))).status).toBe(413);

  const chunked = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3072).fill(32));
      controller.enqueue(new Uint8Array(3072).fill(32));
      controller.close();
    },
  });

  expect((await post("/v1/push", chunked)).status).toBe(413);
  expect(providerCalls).toHaveLength(0);

  expect((await post("/v1/push", JSON.stringify(push))).status).toBe(202);
  expect((await post("/v1/push", JSON.stringify({ ...push, platform: "android" }))).status).toBe(202);
  expect((await post("/v1/push", JSON.stringify({ ...push, preview: undefined }))).status).toBe(202);

  const ios = providerCalls[0];
  const android = providerCalls[1];

  expect(ios?.[0]).toBe("https://exp.host/--/api/v2/push/send");
  expect(ios?.[1]).toMatchObject({
    method: "POST",
    redirect: "error",
    tls: { rejectUnauthorized: true },
    proxy: false,
  });
  expect(new Headers(ios?.[1].headers).get("authorization")).toBe(`Bearer ${expoAccessToken}`);

  const common = { to: push.token, ttl: 600, data: { receiptId: push.receiptId, preview } };

  const alert = {
    ...common,
    title: "Canopy",
    body: "You have a new update.",
    sound: "default",
    mutableContent: true,
  };

  expect(JSON.parse(String(ios?.[1].body))).toEqual(alert);
  expect(JSON.parse(String(android?.[1].body))).toEqual({ ...common, priority: "high" });
  expect(JSON.parse(String(providerCalls[2]?.[1].body))).toEqual({ ...alert, data: { receiptId: push.receiptId } });
});

test("keeps Expo send and receipt outcomes distinct and hides provider errors", async () => {
  let providerResponse = accepted();
  const providerCalls: Parameters<ExpoFetch>[] = [];

  start(async (url, init) => {
    providerCalls.push([url, init]);

    return providerResponse;
  });

  const error = (code: string) => ({
    status: "error",
    message: `Credentials for ${push.token}`,
    details: { error: code },
  });

  for (const [code, status] of [
    ["DeviceNotRegistered", 410],
    ["MessageTooBig", 422],
    ["MessageRateExceeded", 429],
    ["InvalidCredentials", 502],
  ] as const) {
    providerResponse = Response.json({ data: error(code) });
    const response = await post("/v1/push", JSON.stringify(push));

    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
  }

  providerResponse = Response.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  expect((await post("/v1/push", JSON.stringify(push))).status).toBe(502);

  const query = JSON.stringify({ ticketId });
  providerResponse = Response.json({ data: {} });
  expect((await post("/v1/receipt", query)).status).toBe(404);

  providerResponse = Response.json({ data: { [ticketId]: { status: "ok" } } });
  expect((await post("/v1/receipt", query)).status).toBe(204);

  providerResponse = Response.json({ data: { [ticketId]: error("DeviceNotRegistered") } });
  expect((await post("/v1/receipt", query)).status).toBe(410);

  providerResponse = Response.json({ data: { [ticketId]: error("InvalidCredentials") } });
  expect((await post("/v1/receipt", query)).status).toBe(204);

  providerResponse = new Response(null, { status: 429 });
  expect((await post("/v1/receipt", query)).status).toBe(429);

  expect(providerCalls.slice(5).map(([url]) => url)).toEqual(
    Array(5).fill("https://exp.host/--/api/v2/push/getReceipts"),
  );
  expect(JSON.parse(String(providerCalls.at(-1)?.[1].body))).toEqual({ ids: [ticketId] });
});

test("limits requests in flight per credential", async () => {
  const started = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  let active = 0;

  start(async (_url, init) => {
    if (String(init.body).includes(push.receiptId)) {
      active++;

      if (active === 4) started.resolve();

      await done.promise;
    }

    return accepted();
  });

  const data = JSON.stringify(push);
  const first = Array.from({ length: 4 }, () => post("/v1/push", data));

  try {
    await Promise.race([
      started.promise,
      ...first.map((request) =>
        request.then((response) => {
          throw new Error(`Expected four in-flight provider requests before a response, got ${response.status}.`);
        }),
      ),
    ]);
    expect((await post("/v1/push", data)).status).toBe(429);
    expect((await post("/v1/push", JSON.stringify({ ...push, receiptId: randomUUID() }), gatewayB)).status).toBe(202);
  } finally {
    done.resolve();
    await Promise.allSettled(first);
  }

  expect((await post("/v1/push", data)).status).toBe(202);
});

test("rate limits invalid payloads per credential before calling Expo", async () => {
  start(async () => accepted());

  let status = 0;

  for (let attempt = 0; attempt < 32 && status !== 429; attempt++) {
    status = (await post("/v1/push", "{}")).status;
  }

  expect(status).toBe(429);
  expect((await post("/v1/push", JSON.stringify(push), gatewayB)).status).toBe(202);
});

const binding = randomBytes(32).toString("base64url");
const iosTarget: PushTarget = { token: push.token, platform: "ios" };
const challengePath = "/v1/enrollment/challenge";
const completePath = "/v1/enrollment/complete";
const renewPath = "/v1/enrollment/renew";
const revokePath = "/v1/enrollment/revoke";
const day = 24 * 60 * 60 * 1000;

const verifier: AttestationVerifier = {
  cloudProjectNumber: "123456789",
  supports: () => true,
  verify: async ({ attestation, challenge }) => attestation === `fixture.${challenge}`,
};

function startManaged(
  options: {
    provider?: ExpoFetch;
    verifier?: AttestationVerifier;
    path?: string;
    now?: () => number;
    includeManual?: boolean;
  } = {},
) {
  managedStore = new EnrollmentStore(options.path ?? ":memory:", options.now);

  start(
    options.provider ?? (async () => accepted()),
    { verifier: options.verifier ?? verifier, store: managedStore },
    options.includeManual ?? false,
  );
}

async function json200(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");

  const result = await readJson(response, 4096, AbortSignal.timeout(1_000));

  if ("status" in result || !jsonObject(result.value)) throw new Error("Expected a JSON response object.");

  return result.value;
}

async function challengeFor(target: ChallengeRequest = { ...iosTarget, binding }) {
  const result = await json200(await post(challengePath, JSON.stringify(target), null));
  const { id, challenge, claim, cloudProjectNumber } = result;

  if (!isUuidV4(id) || !isSecret(challenge) || !isSecret(claim)) throw new Error("Invalid enrollment challenge.");

  expect(cloudProjectNumber).toBe(target.platform === "android" ? verifier.cloudProjectNumber : undefined);

  return { id, challenge, claim };
}

function proof(issued: Awaited<ReturnType<typeof challengeFor>>, { platform, token }: PushTarget = iosTarget) {
  const digest = createHash("sha256")
    .update(`canopy-push-enrollment-v1\n${platform}\n${token}\n${issued.challenge}`)
    .digest("base64url");

  return {
    id: issued.id,
    claim: issued.claim,
    attestation: `fixture.${digest}`,
  };
}

function isTimestamp(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function enroll(evidence: CompleteRequest) {
  const result = await json200(await post(completePath, JSON.stringify(evidence), null));
  const { bearer, expiresAtMs } = result;

  if (!isSecret(bearer) || !isTimestamp(expiresAtMs)) throw new Error("Invalid managed credential.");

  return { bearer, expiresAtMs };
}

test("persists scoped managed leases and accepted tickets across restart and same-binding rotation", async () => {
  let sends = 0;
  const acceptedId = randomUUID();
  const path = join(directory, "enrollment.sqlite");

  const provider: ExpoFetch = async (url) => {
    if (url.endsWith("/getReceipts")) return Response.json({ data: { [acceptedId]: { status: "ok" } } });

    sends++;

    return Response.json({ data: { status: "ok", id: acceptedId } });
  };

  startManaged({ provider, path, includeManual: true });

  const firstProof = proof(await challengeFor());
  const firstGrant = await enroll(firstProof);
  const wrongTarget = { ...push, token: "ExpoPushToken[other-token]" };
  const receipt = JSON.stringify({ ticketId: acceptedId });
  const data = JSON.stringify(push);

  expect(await enroll(firstProof)).toEqual(firstGrant);
  expect((await post("/v1/push", JSON.stringify(wrongTarget), firstGrant.bearer)).status).toBe(403);
  expect((await post("/v1/push", JSON.stringify({ ...push, platform: "android" }), firstGrant.bearer)).status).toBe(
    403,
  );
  expect((await post("/v1/receipt", receipt, firstGrant.bearer)).status).toBe(404);
  expect(sends).toBe(0);
  expect(await (await post("/v1/push", data, firstGrant.bearer)).json()).toEqual({ ticketId: acceptedId });
  expect(sends).toBe(1);

  await relay.stop(true);
  managedStore?.close();
  managedStore = undefined;
  startManaged({ provider, path, includeManual: true });

  expect(await enroll(firstProof)).toEqual(firstGrant);
  expect((await post("/v1/receipt", receipt, firstGrant.bearer)).status).toBe(204);

  const rotated = await enroll(proof(await challengeFor()));

  expect(rotated.bearer).not.toBe(firstGrant.bearer);
  expect((await post("/v1/push", data, firstGrant.bearer)).status).toBe(401);
  expect((await post(completePath, JSON.stringify(firstProof), null)).status).toBe(403);
  expect((await post("/v1/receipt", receipt, rotated.bearer)).status).toBe(204);

  const rePaired = await enroll(
    proof(await challengeFor({ ...iosTarget, binding: randomBytes(32).toString("base64url") })),
  );

  expect((await post("/v1/receipt", receipt, rotated.bearer)).status).toBe(401);
  expect((await post("/v1/receipt", receipt, rePaired.bearer)).status).toBe(404);
  expect((await post("/v1/receipt", receipt, gatewayA)).status).toBe(204);
  expect((await post(renewPath, "{}", gatewayA)).status).toBe(401);

  const stored = readFileSync(path);

  expect(statSync(path).mode & 0o777).toBe(0o600);

  for (const secret of [push.token, firstProof.claim, firstProof.attestation, firstGrant.bearer, rePaired.bearer])
    expect(stored.includes(secret)).toBe(false);
});

test("requires authentic evidence bound to the exact platform and token and expires proofs, receipts and leases", async () => {
  let now = Date.now();
  let verifications = 0;

  startManaged({
    now: () => now,
    verifier: {
      ...verifier,
      verify: (input) => {
        verifications++;

        return verifier.verify(input);
      },
    },
  });

  const androidTarget: PushTarget = { platform: "android", token: "ExpoPushToken[android-token]" };
  const first = await challengeFor({ ...androidTarget, binding });
  const foreignClaim = { ...proof(first, androidTarget), claim: randomBytes(32).toString("base64url") };

  expect((await post(completePath, JSON.stringify(foreignClaim), null)).status).toBe(403);
  expect(verifications).toBe(0);
  expect((await post(completePath, JSON.stringify(proof(first)), null)).status).toBe(403);
  expect((await post(completePath, JSON.stringify(proof(first, androidTarget)), null)).status).toBe(403);
  expect(verifications).toBe(1);

  const expiredChallenge = proof(await challengeFor());

  now += 5 * 60 * 1000;
  expect((await post(completePath, JSON.stringify(expiredChallenge), null)).status).toBe(403);
  expect(verifications).toBe(1);

  const activeProof = proof(await challengeFor());
  const activeGrant = await enroll(activeProof);

  expect(activeGrant.expiresAtMs).toBe(now + 35 * day);
  expect((await post(completePath, JSON.stringify({ ...activeProof, attestation: "modified" }), null)).status).toBe(
    403,
  );
  expect((await post("/v1/push", JSON.stringify(push), activeGrant.bearer)).status).toBe(202);

  now += day;
  expect((await post("/v1/receipt", JSON.stringify({ ticketId }), activeGrant.bearer)).status).toBe(404);
  expect((await post(renewPath, '{"token":"change-target"}', activeGrant.bearer)).status).toBe(400);
  expect(await json200(await post(renewPath, "{}", activeGrant.bearer))).toEqual({ expiresAtMs: now + 35 * day });

  now = activeGrant.expiresAtMs;
  expect(
    (await post("/v1/push", JSON.stringify({ ...push, token: "ExpoPushToken[unknown]" }), activeGrant.bearer)).status,
  ).toBe(403);

  now += day;
  expect((await post(renewPath, "{}", activeGrant.bearer)).status).toBe(401);
  expect((await post("/v1/push", JSON.stringify(push), activeGrant.bearer)).status).toBe(401);
});

test("atomically reserves proofs and fences older verifications after a newer grant is revoked", async () => {
  const started = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  let firstAttestation: string | undefined;
  let verifications = 0;

  startManaged({
    verifier: {
      ...verifier,
      verify: async (input) => {
        verifications++;

        if (input.attestation === firstAttestation) {
          started.resolve();
          await done.promise;
        }

        return verifier.verify(input);
      },
    },
  });

  const firstProof = proof(await challengeFor());

  firstAttestation = firstProof.attestation;

  const first = post(completePath, JSON.stringify(firstProof), null);

  try {
    await Promise.race([
      started.promise,
      first.then((response) => {
        throw new Error(`Expected verification to start before the relay replied, got ${response.status}.`);
      }),
    ]);
    expect((await post(completePath, JSON.stringify(firstProof), null)).status).toBe(409);
    expect(verifications).toBe(1);

    const secondProof = proof(await challengeFor());
    const currentGrant = await enroll(secondProof);

    expect(await enroll(secondProof)).toEqual(currentGrant);
    expect((await post(revokePath, "{}", currentGrant.bearer)).status).toBe(204);

    done.resolve();
    expect((await first).status).toBe(403);
    expect((await post(completePath, JSON.stringify(secondProof), null)).status).toBe(403);
    expect(verifications).toBe(2);
  } finally {
    done.resolve();
    await Promise.allSettled([first]);
  }
});

test("rejects enrollment when disabled and rates requests by the actual TLS peer and managed grant", async () => {
  start(async () => accepted());
  expect((await post(challengePath, JSON.stringify({ ...iosTarget, binding }), null)).status).toBe(404);
  await relay.stop(true);

  let verifications = 0;

  startManaged({
    verifier: {
      ...verifier,
      verify: (input) => {
        verifications++;

        return verifier.verify(input);
      },
    },
  });

  const valid = proof(await challengeFor());
  const grant = await enroll(valid);
  const pending = proof(await challengeFor());
  let status = 0;

  for (let attempt = 0; attempt < 32 && status !== 429; attempt++) {
    const response = await post(completePath, "{}", null, {
      headers: {
        "content-type": "application/json",
        forwarded: `for=198.51.100.${attempt}`,
        "x-forwarded-for": `198.51.100.${attempt}`,
      },
    });

    status = response.status;
  }

  expect(status).toBe(429);
  expect((await post(completePath, JSON.stringify(pending), null)).status).toBe(429);
  expect((await post(challengePath, JSON.stringify({ ...iosTarget, binding }), null)).status).toBe(429);
  expect(verifications).toBe(1);

  status = 0;

  for (let attempt = 0; attempt < 16 && status !== 429; attempt++) {
    status = (await post("/v1/push", "{}", grant.bearer)).status;
  }

  expect(status).toBe(429);
  expect((await post(revokePath, "{}", grant.bearer)).status).toBe(204);
});

test("signals reattestation at the absolute lease cap and resets it with fresh proof", async () => {
  const issuedAt = Date.now();
  let now = issuedAt;

  startManaged({ now: () => now });

  const first = await enroll(proof(await challengeFor()));

  now = issuedAt + 30 * day;
  expect(await json200(await post(renewPath, "{}", first.bearer))).toEqual({ expiresAtMs: issuedAt + 65 * day });

  now = issuedAt + 55 * day;
  expect(await json200(await post(renewPath, "{}", first.bearer))).toEqual({
    expiresAtMs: issuedAt + 90 * day,
    reattest: true,
  });

  now = issuedAt + 89 * day;
  expect(await json200(await post(renewPath, "{}", first.bearer))).toEqual({
    expiresAtMs: issuedAt + 90 * day,
    reattest: true,
  });
  expect((await post("/v1/push", JSON.stringify(push), first.bearer)).status).toBe(202);

  const rotatedAt = now;
  const rotated = await enroll(proof(await challengeFor()));

  expect((await post(renewPath, "{}", first.bearer)).status).toBe(401);
  expect(rotated.expiresAtMs).toBe(rotatedAt + 35 * day);

  now = rotatedAt + 30 * day;
  expect(await json200(await post(renewPath, "{}", rotated.bearer))).toEqual({
    expiresAtMs: rotatedAt + 65 * day,
  });

  now = rotatedAt + 55 * day;
  expect(await json200(await post(renewPath, "{}", rotated.bearer))).toEqual({
    expiresAtMs: rotatedAt + 90 * day,
    reattest: true,
  });

  now = rotatedAt + 90 * day;
  expect((await post(renewPath, "{}", rotated.bearer)).status).toBe(401);
  expect((await post(revokePath, "{}", rotated.bearer)).status).toBe(204);
});

test("migrates existing grants and tickets with a single 35-day grace period", async () => {
  const migratedAt = Date.now();
  const path = join(directory, "old-enrollment.sqlite");
  const credential = randomBytes(32).toString("base64url");
  const grant = randomUUID();
  const legacy = new Database(path);

  try {
    legacy.exec(enrollmentSchema);
    legacy
      .query(
        `INSERT INTO grants (id, scope, binding, platform, generation, bearer_hash, expires_at)
         VALUES (?, ?, ?, 'ios', 1, ?, ?)`,
      )
      .run(grant, pushScope(iosTarget), digest(binding), digest(credential), migratedAt + 45 * day);
    legacy.query("INSERT INTO tickets VALUES (?, ?, ?)").run(digest(ticketId), grant, migratedAt + day);
  } finally {
    legacy.close();
  }

  let now = migratedAt;
  const provider: ExpoFetch = async () => Response.json({ data: { [ticketId]: { status: "ok" } } });

  startManaged({ path, now: () => now, provider });
  expect((await post("/v1/receipt", JSON.stringify({ ticketId }), credential)).status).toBe(204);
  expect(await json200(await post(renewPath, "{}", credential))).toEqual({
    expiresAtMs: migratedAt + 35 * day,
    reattest: true,
  });

  await relay.stop(true);
  managedStore?.close();
  managedStore = undefined;
  now += 34 * day;

  startManaged({ path, now: () => now, provider });
  expect(await json200(await post(renewPath, "{}", credential))).toEqual({
    expiresAtMs: migratedAt + 35 * day,
    reattest: true,
  });

  now += day;
  expect((await post(renewPath, "{}", credential)).status).toBe(401);
});

test("revokes only the exact bearer, including when all attestation providers are disabled", async () => {
  const path = join(directory, "revoked-enrollment.sqlite");

  startManaged({ path, includeManual: true });

  const first = await enroll(proof(await challengeFor()));
  const current = await enroll(proof(await challengeFor()));

  expect((await post(revokePath, "{}", null)).status).toBe(401);
  expect((await post(revokePath, "{}", current.bearer + "=")).status).toBe(401);
  expect((await post(revokePath, "[]", current.bearer)).status).toBe(400);
  expect((await post(revokePath, '{"token":"anything"}', current.bearer)).status).toBe(400);
  expect((await post(revokePath, "{}", first.bearer)).status).toBe(204);
  expect((await post(revokePath, "{}", gatewayA)).status).toBe(204);
  expect((await post(renewPath, "{}", current.bearer)).status).toBe(200);
  expect((await post("/v1/push", JSON.stringify(push), gatewayA)).status).toBe(202);

  await relay.stop(true);
  managedStore?.close();
  managedStore = new EnrollmentStore(path);
  start(async () => accepted(), { store: managedStore }, false);

  expect((await post(challengePath, JSON.stringify({ ...iosTarget, binding }), null)).status).toBe(404);
  expect((await post(revokePath, "{}", current.bearer)).status).toBe(204);
  expect((await post(revokePath, "{}", current.bearer)).status).toBe(204);

  await relay.stop(true);
  managedStore.close();
  managedStore = undefined;
  startManaged({ path });

  expect((await post(renewPath, "{}", current.bearer)).status).toBe(401);
  expect((await post("/v1/push", JSON.stringify(push), current.bearer)).status).toBe(401);
});

test("sends silent dismissals only within the grant scope and keeps no ticket", async () => {
  const bodies: JsonValue[] = [];
  const badge = randomBytes(40).toString("base64url");
  const dismissal = { token: iosTarget.token, platform: "ios", dismissId: randomUUID(), receiptIds: [randomUUID()] };

  startManaged({
    provider: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));

      return accepted();
    },
  });
  const { bearer } = await enroll(proof(await challengeFor()));

  const invalid = [
    { ...dismissal, receiptIds: [] },
    { ...dismissal, receiptIds: Array.from({ length: 33 }, () => randomUUID()) },
    { ...dismissal, receiptIds: [dismissal.receiptIds[0], dismissal.receiptIds[0]] },
    { ...dismissal, receiptIds: ["not-a-receipt"] },
    { ...dismissal, badge: badge + "=" },
    { ...dismissal, preview },
  ];

  for (const body of invalid) expect((await post("/v1/dismiss", JSON.stringify(body), bearer)).status).toBe(400);
  const elsewhere = { ...dismissal, token: "ExpoPushToken[other-token]" };
  expect((await post("/v1/dismiss", JSON.stringify(elsewhere), bearer)).status).toBe(403);
  expect(bodies).toHaveLength(0);

  expect((await post("/v1/dismiss", JSON.stringify({ ...dismissal, badge }), bearer)).status).toBe(204);
  const { dismissId, receiptIds } = dismissal;
  const data = { dismiss: receiptIds, dismissId, badge };
  expect(bodies).toEqual([{ to: iosTarget.token, ttl: 3600, data, priority: "normal", _contentAvailable: true }]);
  expect((await post("/v1/receipt", JSON.stringify({ ticketId }), bearer)).status).toBe(404);
});
