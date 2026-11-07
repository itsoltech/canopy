import * as tls from "node:tls";
import {
  Code,
  ConnectError,
  createClient,
  createContextKey,
  createContextValues,
  type ConnectRouter,
} from "@connectrpc/connect";
import { connectNodeAdapter, createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { computerLink as link } from "@canopy/contracts";
import type { Handler } from "../network/listener.ts";
import { certificateIdentity, linkAddress } from "./identity.ts";
import {
  PEER_CONNECT_TIMEOUT_MS,
  PEER_IDLE_CONNECTION_TIMEOUT_MS,
  PEER_PING_INTERVAL_MS,
  PEER_PING_TIMEOUT_MS,
} from "./timing.ts";

export const remoteCertificate = createContextKey("");

export type LinkIdentity = { certificate: string; privateKey: string };

/** Learn the certificate only after checking the out-of-band invitation pin.
 * No HTTP request or pairing secret is sent on this discovery connection. */
export function discoverCertificate(address: string, fingerprint: string, identity: LinkIdentity): Promise<string> {
  const url = new URL(linkAddress(address));

  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || 443),
      cert: identity.certificate,
      key: identity.privateKey,
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
      ALPNProtocols: ["h2"],
    });

    socket.setTimeout(PEER_CONNECT_TIMEOUT_MS, () => socket.destroy(new Error("Computer link timed out")));
    socket.once("error", (cause) =>
      reject(
        new ConnectError(
          "The computer is unreachable. Check the address and that network access is on there.",
          Code.Unavailable,
          undefined,
          undefined,
          cause,
        ),
      ),
    );
    socket.once("secureConnect", () => {
      try {
        const remote = certificateIdentity(socket.getPeerCertificate().raw);

        if (remote.fingerprint !== fingerprint)
          throw new ConnectError(
            "Computer certificate changed. Unlink and create a new pairing code on the other computer.",
            Code.Unauthenticated,
          );
        socket.end();
        resolve(remote.certificate);
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
  });
}

/** The peer's exact self-signed certificate is the ONLY trust anchor. System
 * CAs are replaced, hostname validation is replaced by the stronger exact pin. */
export function linkClient(address: string, certificate: string, identity: LinkIdentity) {
  const pin = certificateIdentity(certificate).fingerprint;
  const baseUrl = linkAddress(address);

  const session = new Http2SessionManager(
    baseUrl,
    {
      connectTimeoutMs: PEER_CONNECT_TIMEOUT_MS,
      pingIntervalMs: PEER_PING_INTERVAL_MS,
      pingTimeoutMs: PEER_PING_TIMEOUT_MS,
      idleConnectionTimeoutMs: PEER_IDLE_CONNECTION_TIMEOUT_MS,
    },
    {
      cert: identity.certificate,
      key: identity.privateKey,
      ca: certificate,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      checkServerIdentity: (_hostname, cert) =>
        certificateIdentity(cert.raw).fingerprint === pin
          ? undefined
          : new Error("Computer certificate does not match its pin"),
    },
  );

  return Object.assign(
    createClient(
      link.ComputerLinkService,
      createGrpcTransport({ baseUrl, readMaxBytes: 64 * 1024, writeMaxBytes: 64 * 1024, sessionManager: session }),
    ),
    { close: () => session.abort() },
  );
}

/** The link service on the network access listener (network/listener.ts). Only computers that
 * present a certificate reach it, over TLS 1.3. */
export function linkHandler(routes: (router: ConnectRouter) => void): Handler {
  const adapter = connectNodeAdapter({
    routes,
    readMaxBytes: 64 * 1024,
    writeMaxBytes: 64 * 1024,
    contextValues: (request) => {
      const socket = request.socket;

      if (!(socket instanceof tls.TLSSocket)) throw new Error("Expected a TLS socket");
      const raw = socket.getPeerCertificate()?.raw;

      return createContextValues().set(remoteCertificate, raw ? certificateIdentity(raw).certificate : "");
    },
  });

  return (request, response) => {
    try {
      if (!(request.socket instanceof tls.TLSSocket) || request.socket.getProtocol() !== "TLSv1.3")
        throw new Error("Expected TLS 1.3");
      const raw = request.socket.getPeerCertificate()?.raw;

      if (!raw) throw new Error();
      // Pair must accept a new self-signed certificate. Every RPC verifies TLS
      // proof of possession + self signature; Connect additionally requires a pin.
      certificateIdentity(raw);

      return adapter(request, response);
    } catch {
      response.writeHead(403);
      response.end();
    }
  };
}
