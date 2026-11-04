import type { Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { certificatePin } from "./pinned.ts";

export interface GrpcClientOptions {
  readonly baseUrl: string;
  /** Extra trusted CA (PEM), e.g. a self-hosted gateway certificate. System CAs stay trusted. */
  readonly ca?: string | Buffer;
  /** Exact SHA-256 pin; requires the matching certificate in ca. CA validation stays enabled. */
  readonly fingerprint?: string;
  /** HTTP/2 PING interval. Detects dead connections behind NAT; 0 disables. */
  readonly pingIntervalMs?: number;
  readonly connectTimeoutMs?: number;
}

/** gRPC over HTTP/2 client transport (h2c for http://, TLS for https://). */
export function createGrpcClientTransport(options: GrpcClientOptions): Transport {
  if (
    options.fingerprint &&
    (!options.ca || !options.baseUrl.startsWith("https://") || !/^[a-f0-9]{64}$/i.test(options.fingerprint))
  )
    throw new Error("Pinned gRPC requires HTTPS, a certificate and the full fingerprint");

  return createGrpcTransport({
    baseUrl: options.baseUrl,
    ...(options.ca !== undefined && {
      nodeOptions: {
        ca: options.ca,
        ...(options.fingerprint && {
          checkServerIdentity: (_host: string, cert: import("node:tls").PeerCertificate) =>
            certificatePin(cert.raw) === options.fingerprint!.toLowerCase()
              ? undefined
              : new Error("Gateway certificate changed; enroll again"),
        }),
      },
    }),
    ...(options.pingIntervalMs && { pingIntervalMs: options.pingIntervalMs }),
    ...(options.connectTimeoutMs !== undefined && { connectTimeoutMs: options.connectTimeoutMs }),
  });
}
