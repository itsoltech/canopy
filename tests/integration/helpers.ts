import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerLink, type WorkerConnection, type WorkerLinkOptions } from "@open-agents/gateway/worker-link";
import { openGatewayLink, type GatewayLinkOptions } from "@open-agents/worker/gateway-link";
import { Provider } from "@open-agents/contracts";
import { startGrpcServer, type TlsMaterial } from "@open-agents/transport";

export const CREDENTIALS: Readonly<Record<string, string>> = {
  "secret-worker-1": "worker-1",
  "secret-worker-2": "worker-2",
};

export interface TestCert extends TlsMaterial {
  readonly cleanup: () => void;
}

/** Self-signed certificate for 127.0.0.1/localhost, valid 1 day. */
export function makeSelfSignedCert(): TestCert {
  const dir = mkdtempSync(join(tmpdir(), "open-agents-tls-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const result = Bun.spawnSync([
    "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-days", "1", "-subj", "/CN=open-agents-test",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout", key, "-out", cert,
  ]);
  if (result.exitCode !== 0) throw new Error(`openssl failed: ${result.stderr.toString()}`);
  return {
    key: readFileSync(key),
    cert: readFileSync(cert),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export async function startGateway(options: { tls?: TlsMaterial; link?: Partial<WorkerLinkOptions> } = {}) {
  const connected: WorkerConnection[] = [];
  const waiters: Array<(c: WorkerConnection) => void> = [];
  const link = createWorkerLink({
    authenticate: async (credential) => CREDENTIALS[credential],
    welcome: async () => ({ heartbeatIntervalSeconds: 15 }),
    onConnected: (connection) => {
      connected.push(connection);
      waiters.shift()?.(connection);
    },
    ...options.link,
  });
  const server = await startGrpcServer({ routes: link.routes, ...(options.tls && { tls: options.tls }) });
  return {
    server,
    link,
    /** Next connection accepted by the gateway (or one that already arrived and was not taken). */
    nextConnection: (): Promise<WorkerConnection> => {
      const ready = connected.shift();
      return ready ? Promise.resolve(ready) : new Promise((resolve) => waiters.push(resolve));
    },
  };
}

export function connectWorker(baseUrl: string, overrides: Partial<GatewayLinkOptions> = {}) {
  return openGatewayLink({
    baseUrl,
    credential: "secret-worker-1",
    hello: {
      workerId: "worker-1",
      host: { hostname: "test-host", os: process.platform, arch: process.arch, workerVersion: "0.0.0-test" },
      providers: [{ provider: Provider.CLAUDE, available: true }],
    },
    ...overrides,
  });
}

/** Takes the next `count` items without ending the stream (no `break`, which would call return()). */
export async function take<T>(stream: AsyncIterable<T>, count: number): Promise<T[]> {
  const iterator = stream[Symbol.asyncIterator]();
  const items: T[] = [];
  while (items.length < count) {
    const next = await iterator.next();
    if (next.done) break;
    items.push(next.value);
  }
  return items;
}
