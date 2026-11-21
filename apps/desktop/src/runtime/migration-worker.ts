import { randomUUID, X509Certificate } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { WorkerLinkService } from "@canopy/contracts";
import { createGrpcClientTransport, pinnedCertificate, pinnedOrigins, type PinnedRoutes } from "@canopy/transport";
import { createClient } from "@connectrpc/connect";
import { Result } from "effect";
import { checkFilePermissions, parseLocalConfig, type LocalConfig } from "../../../worker/src/config/local.ts";
import { remoteWorkerDirectory } from "../remote-client.ts";

interface WorkerHandoffOptions {
  readonly directory: string;
  /** Stable Remote profile key, also used by the Desktop credential vault. */
  readonly workerGatewayUrl: string;
  /** From trusted migration metadata or Desktop pairing, never discovered from an unauthenticated peer. */
  readonly routes: PinnedRoutes;
  /** Assert the caller still holds the exclusive lifecycle fence and has awaited both worker exits. */
  assertStopped(): void | Promise<void>;
  readonly signal?: AbortSignal;
}

type PinnedEndpoint = Required<Pick<LocalConfig, "gateway_url" | "gateway_certificate" | "gateway_fingerprint">>;

/**
 * Prepare the standard Remote worker profile using the local worker's existing enrollment and absolute data path.
 * Call after the target has restored the worker record and the source gateway is durably fenced. The caller
 * must keep Local startup fenced through crash recovery and start Remote with the returned workerGatewayUrl
 * and no enrollment token. The Desktop UI credential and mode switch are owned by the caller.
 */
export async function handoffDesktopWorker(options: WorkerHandoffOptions) {
  await options.assertStopped();
  options.signal?.throwIfAborted();
  const directory = resolve(options.directory);
  const workerGatewayUrl = pinnedOrigins([options.workerGatewayUrl])[0]!;
  const addresses = pinnedOrigins(options.routes.addresses);
  const fingerprint = options.routes.fingerprint.toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Use the target gateway's full SHA-256 fingerprint");

  const sourceDirectory = join(directory, "local-worker");
  const sourcePath = join(sourceDirectory, "worker.json");
  const source = readWorker(sourceDirectory, sourcePath);

  if (!source) throw new Error("The local Desktop worker is not enrolled");

  if (
    !source.data_dir ||
    !isAbsolute(source.data_dir) ||
    !lstatSync(join(source.data_dir, "journal.db"), { throwIfNoEntry: false })?.isFile()
  )
    throw new Error("The local Desktop worker needs an existing journal in its absolute data directory");

  if (source.gateway_fingerprint === fingerprint || workerGatewayUrl === source.gateway_url)
    throw new Error("Use the migrated gateway's Network access routes");

  const workerDirectory = remoteWorkerDirectory(directory, { mode: "remote", gatewayUrl: workerGatewayUrl });
  const path = join(workerDirectory, "worker.json");
  const marker = join(sourceDirectory, "migration-handoff.json");
  const binding = JSON.stringify({ version: 1, workerId: source.worker_id, workerGatewayUrl, fingerprint }) + "\n";

  const existing = () => {
    const prior = readPrivateText(marker);

    if (prior !== undefined && prior !== binding) throw new Error("The local worker is bound to a different handoff");

    checkDirectory(dirname(workerDirectory));

    if (checkDirectory(workerDirectory) && lstatSync(join(workerDirectory, "data"), { throwIfNoEntry: false }))
      throw new Error("The Remote profile already has its own worker data");

    const worker = readWorker(workerDirectory, path);

    if (worker && (prior === undefined || !matchesHandoff(source, worker, fingerprint)))
      throw new Error("The Remote profile already has a different worker configuration");

    return { prior, worker };
  };

  let { prior, worker } = existing();

  if (!worker) {
    const endpoint = await probeWorkerRoute(
      source,
      addresses.filter((address) => address !== source.gateway_url),
      fingerprint,
      options.signal,
    );

    await options.assertStopped();
    options.signal?.throwIfAborted();

    if (!isDeepStrictEqual(source, readWorker(sourceDirectory, sourcePath)))
      throw new Error("The local worker configuration changed during the handoff");

    ({ prior, worker } = existing());

    if (!worker) {
      // Bind the source before publishing a launchable destination. Recovery with this binding can finish the write.
      if (prior === undefined) publishPrivateFile(marker, binding);
      syncDirectory(sourceDirectory);
      syncDirectory(directory);
      mkdirSync(workerDirectory, { recursive: true, mode: 0o700 });
      worker = withPinnedRoute(source, endpoint);
      publishPrivateFile(path, JSON.stringify(worker, null, 2) + "\n");
    }
  }

  syncDirectory(sourceDirectory);
  syncDirectory(workerDirectory);
  syncDirectory(dirname(workerDirectory));
  syncDirectory(directory);

  return { workerId: worker.worker_id, workerDirectory, workerGatewayUrl, gatewayUrl: worker.gateway_url };
}

async function probeWorkerRoute(
  source: LocalConfig,
  addresses: string[],
  fingerprint: string,
  signal?: AbortSignal,
): Promise<PinnedEndpoint> {
  const complete = new AbortController();
  const deadline = AbortSignal.any([complete.signal, AbortSignal.timeout(5000), ...(signal ? [signal] : [])]);

  try {
    const endpoint = await Promise.any(
      addresses.map(async (address) => {
        const ca = await pinnedCertificate(address, fingerprint, deadline);

        const client = createClient(
          WorkerLinkService,
          createGrpcClientTransport({ baseUrl: address, ca, fingerprint }),
        );

        await client.probeNetworkRoute(
          { workerId: source.worker_id },
          {
            headers: { authorization: `Bearer ${source.credential}` },
            signal: deadline,
            timeoutMs: 3000,
          },
        );

        return { gateway_url: address, gateway_certificate: ca, gateway_fingerprint: fingerprint };
      }),
    );

    complete.abort();

    return endpoint;
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      "No pinned target route accepted the existing worker. Check the routes and the restored worker record.",
    );
  }
}

function withPinnedRoute(source: LocalConfig, endpoint: PinnedEndpoint): LocalConfig {
  const { ca_file: _ca, gateway_fallback: _fallback, trusted_http_origin: _http, ...state } = source;

  return { ...state, ...endpoint };
}

function matchesHandoff(source: LocalConfig, worker: LocalConfig, fingerprint: string): boolean {
  const { gateway_url, gateway_certificate, gateway_fingerprint } = worker;

  try {
    return (
      gateway_certificate !== undefined &&
      gateway_fingerprint === fingerprint &&
      new X509Certificate(gateway_certificate).fingerprint256.replaceAll(":", "").toLowerCase() === fingerprint &&
      pinnedOrigins([gateway_url])[0] === gateway_url &&
      isDeepStrictEqual(worker, withPinnedRoute(source, { gateway_url, gateway_certificate, gateway_fingerprint }))
    );
  } catch {
    return false;
  }
}

function checkDirectory(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });

  if (stat && !stat.isDirectory()) throw new Error("A Desktop worker profile is not a regular directory");

  return stat !== undefined;
}

function readWorker(directory: string, path: string): LocalConfig | undefined {
  if (!checkDirectory(directory)) return undefined;
  const text = readPrivateText(path);

  if (text === undefined) return undefined;
  const parsed = parseLocalConfig(text);

  if (Result.isFailure(parsed)) throw new Error("Invalid Desktop worker configuration");

  return parsed.success;
}

function readPrivateText(path: string): string | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });

  if (!stat) return undefined;

  if (!stat.isFile() || checkFilePermissions(path, process.platform))
    throw new Error("Desktop worker handoff requires private, regular files");

  return readFileSync(path, "utf8");
}

/** Atomically publish without replacing another profile or an earlier binding. */
function publishPrivateFile(path: string, data: string) {
  const temporary = `${path}.${randomUUID()}.pending`;
  const fd = openSync(temporary, "wx", 0o600);

  try {
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
