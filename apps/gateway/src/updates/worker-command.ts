import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { update } from "@canopy/contracts";
import { workerLinkCompatible } from "@canopy/domain/release/protocol";
import {
  assertBinaryUpdateForward,
  compareVersions,
  managedInstructions,
  releaseAsset,
  type ReleaseMirror,
} from "@canopy/updater";
import type { UpdatePersistence } from "./persistence.ts";
import { versionAhead } from "./versions.ts";

export async function workerCommandOnHello(
  persistence: Pick<UpdatePersistence, "workers">,
  mirror: ReleaseMirror,
  hello: update.CheckRequest,
  queue: () => Promise<update.UpdateCommand | undefined>,
): Promise<update.UpdateCommand | undefined> {
  const worker = (await persistence.workers()).find((item) => item.id === hello.workerId);
  const { version, source } = mirror;

  if (!worker) return undefined;

  if (
    worker.command?.version === version &&
    !["failed", "succeeded", "managed_externally"].includes(worker.status.state ?? "") &&
    worker.command.version !== hello.version
  ) {
    await assertBinaryUpdateForward(source.catalog, hello.version, { version });

    return worker.command;
  }

  // No automatic downgrade or repeated failed-update loop, including after rollback.
  if (hello.installKind === "binary" && worker.status.state !== "failed" && versionAhead(version, hello.version))
    return queue();

  return undefined;
}

export async function prepareWorkerUpdate(
  persistence: Pick<UpdatePersistence, "workers" | "saveCommand">,
  mirror: ReleaseMirror,
  workerId: string,
  force: boolean,
  allowDowngrade: boolean,
): Promise<update.UpdateCommand | undefined> {
  // Auto-update on Hello and Update all share one command, including when their earlier reads raced.
  const worker = (await persistence.workers()).find((item) => item.id === workerId);
  const { version, source } = mirror;

  if (!worker) throw new ConnectError("Worker not found", Code.NotFound);

  if (worker.version === version) return undefined;

  if (worker.status.installKind !== "binary")
    throw new ConnectError(managedInstructions(worker.status.installKind ?? "source"), Code.FailedPrecondition);

  if (compareVersions(version, worker.version) < 0 && !allowDowngrade)
    throw new ConnectError("Worker downgrade requires an explicit user request", Code.FailedPrecondition);
  await assertBinaryUpdateForward(source.catalog, worker.version, { version });

  if (
    worker.command?.version === version &&
    !["failed", "succeeded", "managed_externally"].includes(worker.status.state ?? "")
  )
    return worker.command;
  const manifest = await mirror.manifest();

  if (!workerLinkCompatible(manifest.protocol.worker_link, manifest.protocol.worker_link))
    throw new ConnectError("Worker release is incompatible with this gateway protocol", Code.FailedPrecondition);
  releaseAsset(manifest, "worker", worker.os, worker.arch);

  const command = create(update.UpdateCommandSchema, {
    id: crypto.randomUUID(),
    version,
    manifestJson: JSON.stringify(manifest),
    force,
    allowDowngrade,
    maxIdleWaitSeconds: 30 * 60,
    preferGatewayMirror: true,
  });

  await persistence.saveCommand(worker.id, command);

  return command;
}
