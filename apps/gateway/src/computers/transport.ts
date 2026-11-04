import * as http2 from "node:http2";
import * as tls from "node:tls";
import type { AddressInfo } from "node:net";
import {
  Code,
  ConnectError,
  createClient,
  createContextKey,
  createContextValues,
  type ConnectRouter,
} from "@connectrpc/connect";
import { connectNodeAdapter, createGrpcTransport } from "@connectrpc/connect-node";
import { computerLink as link } from "@canopy/contracts";
import { certificateIdentity, linkAddress } from "./identity.ts";

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

    socket.setTimeout(5000, () => socket.destroy(new Error("Computer link timed out")));
    socket.once("error", () =>
      reject(
        new ConnectError("The computer is unreachable. Check the address and listener settings.", Code.Unavailable),
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

  return createClient(
    link.ComputerLinkService,
    createGrpcTransport({
      baseUrl: linkAddress(address),
      readMaxBytes: 64 * 1024,
      writeMaxBytes: 64 * 1024,
      connectTimeoutMs: 5000,
      pingIntervalMs: 10_000,
      pingTimeoutMs: 5000,
      idleConnectionTimeoutMs: 1000,
      nodeOptions: {
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
    }),
  );
}

export async function listenLink(options: {
  host: string;
  port: number;
  identity: LinkIdentity;
  routes: (router: ConnectRouter) => void;
}) {
  const adapter = connectNodeAdapter({
    routes: options.routes,
    readMaxBytes: 64 * 1024,
    writeMaxBytes: 64 * 1024,
    contextValues: (request) => {
      const socket = request.socket as tls.TLSSocket;
      const raw = socket.getPeerCertificate()?.raw;

      return createContextValues().set(remoteCertificate, raw ? certificateIdentity(raw).certificate : "");
    },
  });

  const server = http2.createSecureServer(
    {
      cert: options.identity.certificate,
      key: options.identity.privateKey,
      minVersion: "TLSv1.3",
      requestCert: true,
      // Pair must accept a new self-signed certificate. Every RPC verifies TLS
      // proof of possession + self signature; Connect additionally requires a pin.
      rejectUnauthorized: false,
      handshakeTimeout: 5000,
      settings: { maxConcurrentStreams: 8 },
    },
    (request, response) => {
      try {
        const raw = (request.socket as tls.TLSSocket).getPeerCertificate()?.raw;

        if (!raw) throw new Error();
        certificateIdentity(raw);

        return adapter(request, response);
      } catch {
        response.writeHead(403);
        response.end();
      }
    },
  );

  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());

        for (const session of sessions) session.destroy();
      }),
  };
}
