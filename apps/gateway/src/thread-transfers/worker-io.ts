import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ThreadTransferOperationSchema, ThreadTransferResult } from "@canopy/contracts";
import { THREAD_TRANSFER_CAPABILITY } from "@canopy/domain/release/protocol";
import type { GatewayCore } from "../core/core.ts";
import { InvalidError } from "../core/core-context.ts";
import { coreWorkerQuery, WorkerQueryError } from "../core/core-mentions.ts";
import type { TransferIo } from "../workspace-copy/transfer.ts";

/** One thread transfer operation on a worker (docs/thread-transfers.md); never queued in the outbox. */
export async function transferOperation(
  core: GatewayCore,
  workerId: string,
  operation: MessageInitShape<typeof ThreadTransferOperationSchema>,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<ThreadTransferResult> {
  try {
    const result = await coreWorkerQuery(core, workerId, { case: "threadTransfer", value: operation }, timeoutMs, {
      requiredCapability: THREAD_TRANSFER_CAPABILITY,
      signal,
    });

    if (!result.threadTransfer) throw new InvalidError("The worker did not answer the move. Update it and try again.");

    return result.threadTransfer;
  } catch (error) {
    // Refusals of the transfer itself were written for the owner; other worker errors are not shown verbatim.
    if (error instanceof WorkerQueryError)
      throw new InvalidError(
        error.code === "THREAD_TRANSFER_FAILED" || error.code.startsWith("CWD_")
          ? error.message
          : "The worker could not take part in the move. Try again.",
      );

    if (error instanceof InvalidError && error.message === "Update this worker to use this Git operation.")
      throw new InvalidError("Update both workers to move threads between them.");
    throw error;
  }
}

/** Frames between the two workers' transfer directories, read on the source and written on the target. */
export function workerIo(core: GatewayCore, source: string, target: string, signal: AbortSignal): TransferIo {
  return {
    read: async (reads) => {
      // SAFETY: every read of a frame carries the same token, the transfer id.
      const token = reads[0]!.token;

      const result = await transferOperation(
        core,
        source,
        { action: { case: "readBatch", value: { token, reads } } },
        120_000,
        signal,
      );

      if (!result.batch) throw new InvalidError("The transfer lost its place. Try again.");

      return result.batch;
    },
    write: async (chunks) => {
      // SAFETY: as above.
      const token = chunks[0]!.token;
      await transferOperation(
        core,
        target,
        { action: { case: "writeBatch", value: { token, chunks } } },
        120_000,
        signal,
      );
    },
  };
}
