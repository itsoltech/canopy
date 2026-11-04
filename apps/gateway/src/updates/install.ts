import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { releaseAsset } from "@canopy/updater";
import type { GatewayUpdates } from "./runtime.ts";

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

    const manifest = request.channelFallback
      ? await updates.source.resolve((await updates.snapshot()).channel)
      : await mirror.manifest();

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
