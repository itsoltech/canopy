import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { createClient } from "@connectrpc/connect";
import { WorkerEnrollmentService } from "@canopy/contracts";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { createGrpcClientTransport, pinnedCertificate } from "@canopy/transport";
import type { LocalConfig } from "./config/local.ts";
import { isStandalone, serviceSnippet } from "@canopy/updater";

export interface EnrollmentOptions {
  gateway: string;
  fingerprint?: string;
  token: string;
  configPath: string;
  dataDir?: string;
  force?: boolean;
}

/** Reserve the destination before spending the one-use token. Never print the returned credential. */
export async function enrollWorker(options: EnrollmentOptions): Promise<LocalConfig> {
  const url = new URL(options.gateway);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Use the gateway origin with its gRPC port");
  const path = resolve(options.configPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  if (!options.force && existsSync(path)) throw new Error("Worker config already exists; use --force to replace it");
  // --force replaces via rename, including a symlink, without following it or truncating the old config.
  const target = options.force ? `${path}.${crypto.randomUUID()}.enrolling` : path;
  const fd = openSync(target, "wx", 0o600);

  try {
    const fingerprint = options.fingerprint?.toLowerCase();
    const certificate = fingerprint ? await pinnedCertificate(url.origin, fingerprint) : undefined;

    const client = createClient(
      WorkerEnrollmentService,
      createGrpcClientTransport({
        baseUrl: url.origin,
        connectTimeoutMs: 5_000,
        ...(certificate && fingerprint && { ca: certificate, fingerprint }),
      }),
    );

    let result;

    try {
      result = await client.enroll(
        {
          enrollmentToken: options.token,
          host: { hostname: hostname(), os: process.platform, arch: process.arch, workerVersion: CANOPY_VERSION },
        },
        { timeoutMs: 15_000 },
      );
    } catch {
      throw new Error(
        "Enrollment failed. Check the gateway address and use a valid, unexpired token from Settings → Workers",
      );
    }

    const local: LocalConfig = {
      gateway_url: url.origin,
      worker_id: result.workerId,
      credential: result.workerCredential,
      ...(certificate && fingerprint && { gateway_certificate: certificate, gateway_fingerprint: fingerprint }),
      ...(options.dataDir && { data_dir: resolve(options.dataDir) }),
    };

    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(local, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(fd);

    if (options.force) renameSync(target, path);

    return local;
  } catch (error) {
    unlinkSync(target);
    throw error;
  } finally {
    closeSync(fd);
  }
}

/** How this worker is started again: the standalone binary itself (bun build --compile), else Bun with the source entry. */
export function workerCommand(): readonly string[] {
  const compiled = import.meta.dir.includes("$bunfs") || import.meta.dir.includes("~BUN");

  return compiled ? [process.execPath] : [process.execPath, resolve(import.meta.dir, "main.ts")];
}

/** Snippets contain paths only; credentials stay in worker.json. No automatic service installation. */
export function workerServiceSnippet(
  platform: string,
  configPath: string,
  entrypoint = isStandalone() ? "" : resolve(import.meta.dir, "main.ts"),
  bunPath = process.execPath,
): string {
  return serviceSnippet("worker", platform, bunPath, [
    ...(entrypoint ? [entrypoint] : []),
    "--config",
    resolve(configPath),
  ]);
}
