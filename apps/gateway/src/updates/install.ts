import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { releaseAsset, type ReleaseManifest } from "@canopy/updater";
import { UPDATE_PROTOCOL, workerLinkCompatible } from "@canopy/domain/release/protocol";
import type { GatewayUpdates } from "./runtime.ts";

/** Resolve on the gateway: a desktop's web origin is private to that computer. */
export async function workerInstallManifest(
  updates: GatewayUpdates,
  os?: string,
  arch?: string,
): Promise<ReleaseManifest> {
  const compatible = (manifest: ReleaseManifest) =>
    workerLinkCompatible(manifest.protocol.worker_link, manifest.protocol.worker_link) &&
    manifest.protocol.update === UPDATE_PROTOCOL &&
    manifest.assets.some((asset) => asset.app === "worker" && (!os || (asset.os === os && asset.arch === arch)));

  try {
    const exact = await updates.service.options.mirror.manifest();

    if (compatible(exact)) return exact;
  } catch {
    // An unpublished build may use a published release with the same protocol.
  }

  try {
    return await updates.source.resolve((await updates.snapshot()).channel, compatible);
  } catch {
    throw new ConnectError(
      "No compatible worker release is available. Check the gateway’s access to GitHub Releases or update Canopy.",
      Code.Unavailable,
    );
  }
}

/** Installation uses the same verified mirror as updates, before a worker has credentials. */
export async function* workerInstall(
  updates: GatewayUpdates,
  request: ui.FetchWorkerInstallRequest,
  signal: AbortSignal,
): AsyncIterable<ui.WorkerInstallChunk> {
  const { os, arch } = request;

  if (!((os === "linux" && ["x64", "arm64"].includes(arch)) || (os === "darwin" && arch === "arm64"))) {
    throw new ConnectError("Supported platforms: linux/x64, linux/arm64, darwin/arm64", Code.InvalidArgument);
  }

  try {
    const mirror = updates.service.options.mirror;

    const manifest = request.channelFallback ? await workerInstallManifest(updates, os, arch) : await mirror.manifest();

    const asset = releaseAsset(manifest, "worker", os, arch);
    yield create(ui.WorkerInstallChunkSchema, {
      sha256: asset.sha256,
      version: manifest.version,
      downloadUrl: asset.url,
    });

    if (request.metadataOnly) return;

    if (request.channelFallback)
      throw new ConnectError("Download channel releases directly from GitHub", Code.InvalidArgument);
    const path = await mirror.artifact(os, arch);

    for await (const data of Bun.file(path).stream()) {
      signal.throwIfAborted();
      yield create(ui.WorkerInstallChunkSchema, { data });
    }
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw new ConnectError(
      "No verified worker binary for this gateway version. Use the GitHub release for your channel or publish this gateway version first.",
      Code.Unavailable,
    );
  }
}
