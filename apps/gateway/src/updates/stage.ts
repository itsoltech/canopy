import {
  readUpdateRecord,
  releaseAsset,
  stageBinaryUpdate,
  type ReleaseManifest,
  type ReleaseSource,
} from "@canopy/updater";
import { GatewayReleaseMirror, type UpdateCache } from "./cache.ts";
import type { WorkerUpdateRow } from "./persistence.ts";

/** A failed fsync or restart can still leave a swapped executable awaiting confirmation. */
export async function gatewayUpdateMayBeStaged(binaryPath: string, version: string): Promise<boolean> {
  try {
    const record = await readUpdateRecord(binaryPath);

    return record?.state === "restarting" && record.version === version;
  } catch {
    // An unreadable record cannot prove that the selected release is safe to evict.
    return true;
  }
}

/** Preserve known worker platforms before the gateway swaps to a release that upstream may expire. */
export async function stageGatewayRelease(options: {
  cache: UpdateCache;
  manifest: ReleaseManifest;
  source: ReleaseSource;
  workers: WorkerUpdateRow[];
  binaryPath: string;
  currentVersion: string;
  allowDowngrade: boolean;
}): Promise<void> {
  const { manifest, source } = options;
  const mirror = new GatewayReleaseMirror(options.cache, manifest.version, source);
  await mirror.remember(manifest);

  const platforms = new Map(
    options.workers.filter((w) => w.status.installKind === "binary").map((w) => [`${w.os}/${w.arch}`, w]),
  );

  for (const worker of platforms.values()) {
    if (manifest.assets.some((a) => a.app === "worker" && a.os === worker.os && a.arch === worker.arch))
      await mirror.artifact(worker.os, worker.arch);
  }

  await stageBinaryUpdate({
    binaryPath: options.binaryPath,
    currentVersion: options.currentVersion,
    version: manifest.version,
    commandId: crypto.randomUUID(),
    asset: releaseAsset(manifest, "gateway", process.platform === "win32" ? "windows" : process.platform, process.arch),
    source: source.options,
    allowDowngrade: options.allowDowngrade,
  });
}
