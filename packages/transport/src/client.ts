import type { Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";

export interface GrpcClientOptions {
  readonly baseUrl: string;
  /** Extra trusted CA (PEM), e.g. a self-hosted gateway certificate. System CAs stay trusted. */
  readonly ca?: string | Buffer;
  /** HTTP/2 PING interval. Detects dead connections behind NAT; 0 disables. */
  readonly pingIntervalMs?: number;
  readonly connectTimeoutMs?: number;
}

/** gRPC over HTTP/2 client transport (h2c for http://, TLS for https://). */
export function createGrpcClientTransport(options: GrpcClientOptions): Transport {
  return createGrpcTransport({
    baseUrl: options.baseUrl,
    ...(options.ca !== undefined && { nodeOptions: { ca: options.ca } }),
    ...(options.pingIntervalMs ? { pingIntervalMs: options.pingIntervalMs } : {}),
    ...(options.connectTimeoutMs !== undefined && { connectTimeoutMs: options.connectTimeoutMs }),
  });
}
