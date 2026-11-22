import { resolve } from "node:path";
import { attestationFromEnv } from "./attestation/index.ts";
import { EnrollmentStore } from "./enrollment-store.ts";
import { serveRelay } from "./server.ts";

function required(name: string) {
  const value = Bun.env[name];

  if (!value) throw new Error(`${name} is required.`);

  return value;
}

function gatewayDigests(managed: boolean) {
  if (managed && !Bun.env["CANOPY_PUSH_RELAY_BEARER_SHA256"]) return [];

  const hashes = required("CANOPY_PUSH_RELAY_BEARER_SHA256")
    .toLowerCase()
    .split(",")
    .map((digest) => digest.trim());

  if (hashes.length > 128 || hashes.some((digest) => !/^[0-9a-f]{64}$/.test(digest)))
    throw new Error("CANOPY_PUSH_RELAY_BEARER_SHA256 must contain 1–128 comma-separated SHA-256 hex digests.");

  return Array.from(new Set(hashes), (digest) => Buffer.from(digest, "hex"));
}

function relayPort() {
  const text = Bun.env["CANOPY_PUSH_RELAY_PORT"] ?? "24444";
  const port = Number(text);

  if (!/^\d{1,5}$/.test(text) || port < 1 || port > 65535)
    throw new Error("CANOPY_PUSH_RELAY_PORT must be a port from 1 to 65535.");

  return port;
}

function enrollmentStore(path: string) {
  try {
    return new EnrollmentStore(resolve(path));
  } catch {
    throw new Error("Cannot open the push relay enrollment database. Check CANOPY_PUSH_RELAY_ENROLLMENT_DB.");
  }
}

async function start() {
  const certFile = required("CANOPY_PUSH_RELAY_TLS_CERT_FILE");
  const keyFile = required("CANOPY_PUSH_RELAY_TLS_KEY_FILE");
  const expoAccessToken = required("EXPO_ACCESS_TOKEN");
  const verifier = attestationFromEnv(Bun.env);
  const database = verifier ? required("CANOPY_PUSH_RELAY_ENROLLMENT_DB") : Bun.env["CANOPY_PUSH_RELAY_ENROLLMENT_DB"];
  const digests = gatewayDigests(Boolean(database));
  const hostname = Bun.env["CANOPY_PUSH_RELAY_HOST"] ?? "127.0.0.1";
  const port = relayPort();

  if (!/^[A-Za-z0-9._~+/-]+={0,2}$/.test(expoAccessToken))
    throw new Error("EXPO_ACCESS_TOKEN must be a valid bearer credential.");

  if (!hostname) throw new Error("CANOPY_PUSH_RELAY_HOST must be a bind address.");

  const store = database ? enrollmentStore(database) : undefined;
  const enrollment = store ? { store, ...(verifier && { verifier }) } : undefined;

  try {
    const [cert, key] = await Promise.all([Bun.file(certFile).text(), Bun.file(keyFile).text()]);

    serveRelay({ cert, key, hostname, port, digests, expoAccessToken, ...(enrollment && { enrollment }) });
  } catch {
    store?.close();

    throw new Error("Cannot start the push relay TLS listener. Check the TLS files and bind address.");
  }

  console.info(`Canopy push relay listening on HTTPS port ${port}.`);
}

await start().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : "Cannot start the push relay.");
  process.exitCode = 1;
});
