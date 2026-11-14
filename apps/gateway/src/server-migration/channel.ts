import * as tls from "node:tls";
import type { Http2ServerRequest } from "node:http2";
import {
  Code,
  ConnectError,
  createClient,
  createContextKey,
  createContextValues,
  type ConnectRouter,
} from "@connectrpc/connect";
import { connectNodeAdapter, createGrpcTransport } from "@connectrpc/connect-node";
import { serverMigration as migration } from "@canopy/contracts";
import { pinnedCertificate, pinnedOrigins } from "@canopy/transport";
import { certificateIdentity } from "../computers/identity.ts";
import type { Handler } from "../network/listener.ts";

/** The session a migration certificate belongs to, found by its pin after TLS proved possession. */
export type MigrationPeer = { owner: string; sessionId: string; sourceId: string; generation: number; state: string };

export const migrationPeer = createContextKey<MigrationPeer | undefined>(undefined);

export const IDENTITY_CHANGED = "The server's identity changed. Pair it again before continuing.";

const SERVICE_PATH = `/${migration.MigrationService.typeName}/`;

/** Small control messages only in this stage; data transfer gets its own bounded limits. */
const MESSAGE_LIMIT = 64 * 1024;

const pinCheck = (pin: string) => (_host: string, cert: tls.PeerCertificate) =>
  certificateIdentity(cert.raw).fingerprint === pin ? undefined : new Error(IDENTITY_CHANGED);

/** First route whose TLS certificate matches the pin. Only a handshake: no code or credential is sent
 * before the pin matched (no TOFU, no redirects, no TLS exceptions). */
export async function pinnedTarget(origins: readonly string[], fingerprint: string) {
  let mismatch = false;

  for (const origin of pinnedOrigins(origins)) {
    try {
      return { origin, certificate: await pinnedCertificate(origin, fingerprint, AbortSignal.timeout(5000)) };
    } catch (error) {
      if (error instanceof Error && /does not match/.test(error.message)) mismatch = true;
    }
  }

  throw mismatch
    ? new ConnectError(IDENTITY_CHANGED, Code.PermissionDenied)
    : new ConnectError("The server is unreachable. Check its address and that Network access is on.", Code.Unavailable);
}

type Pinned = { origin: string; certificate: string; fingerprint: string };

/** Pairing: TLS 1.3 to the pinned server without a client certificate. */
export function pairingClient(target: Pinned) {
  return createClient(
    migration.MigrationPairingService,
    createGrpcTransport({
      baseUrl: target.origin,
      readMaxBytes: MESSAGE_LIMIT,
      writeMaxBytes: MESSAGE_LIMIT,
      nodeOptions: {
        ca: target.certificate,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        checkServerIdentity: pinCheck(target.fingerprint),
      },
    }),
  );
}

/** Every later RPC: mutual TLS 1.3, the server pinned, the home's session certificate as its credential. */
export function migrationClient(target: Pinned, session: { certificate: string; privateKey: string }) {
  return createClient(
    migration.MigrationService,
    createGrpcTransport({
      baseUrl: target.origin,
      readMaxBytes: MESSAGE_LIMIT,
      writeMaxBytes: MESSAGE_LIMIT,
      nodeOptions: {
        ca: target.certificate,
        cert: session.certificate,
        key: session.privateKey,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        checkServerIdentity: pinCheck(target.fingerprint),
      },
    }),
  );
}

/** The server's migration branch of Network access (network.ts): only a client certificate that is an
 * active session credential reaches MigrationService, over TLS 1.3. Nothing else is mounted here: no UI,
 * WorkerLink, link, discovery or config sync. Everything else is a 403, as for any certificate on a server. */
export function migrationHandler(
  service: (router: ConnectRouter) => void,
  authorize: (pin: string) => Promise<MigrationPeer | undefined>,
): Handler {
  const peers = new WeakMap<Http2ServerRequest, MigrationPeer>();

  const adapter = connectNodeAdapter({
    routes: service,
    readMaxBytes: MESSAGE_LIMIT,
    writeMaxBytes: MESSAGE_LIMIT,
    // SAFETY: the node adapter passes the HTTP/2 request it was called with; HTTP/1.1 is refused below.
    contextValues: (request) => createContextValues().set(migrationPeer, peers.get(request as Http2ServerRequest)),
  });

  return async (request, response) => {
    try {
      const socket = request.socket;

      if (!(socket instanceof tls.TLSSocket) || socket.getProtocol() !== "TLSv1.3" || request.httpVersionMajor !== 2)
        throw new Error("Expected HTTP/2 over TLS 1.3");

      if (!(request.url ?? "").startsWith(SERVICE_PATH)) throw new Error("Not a migration call");
      const raw = socket.getPeerCertificate()?.raw;

      if (!raw) throw new Error("No certificate");
      const peer = await authorize(certificateIdentity(raw).fingerprint);

      if (!peer) throw new Error("Not a migration credential");
      peers.set(request, peer);

      return adapter(request, response);
    } catch {
      response.writeHead(403);
      response.end();
    }
  };
}
