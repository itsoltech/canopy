import type { BlobChunk } from "@canopy/contracts";
import type { WorkerConnection } from "../worker-link/index.ts";
import { THREAD_BLOB_BYTES } from "../attachments/preview-policy.ts";

const WORKER_FILES = 16;
const WORKER_BYTES = 16 * 1024 * 1024;
const GATEWAY_FILES = 256;
const GATEWAY_BYTES = 128 * 1024 * 1024;
const TRANSFER_MS = 30_000;

type Source = Pick<WorkerConnection, "workerId" | "closed">;

interface Transfer {
  readonly connection: Source;
  readonly key: string;
  readonly mimeType: string;
  buffer: Buffer;
  size: number;
  complete: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export class PreviewBuffers {
  readonly #pending = new Map<Source, Map<string, Transfer>>();
  readonly #observed = new WeakSet<Source>();
  readonly #transfers = new Set<Transfer>();
  constructor(readonly deadlineMs = TRANSFER_MS) {}

  async receive(connection: Source, chunk: BlobChunk, store: (data: Buffer) => Promise<void>): Promise<void> {
    const key = `${chunk.threadId}:${chunk.sha256}`;
    let transfer = this.#pending.get(connection)?.get(key);

    if (transfer?.complete) return;

    if (transfer && (chunk.offset !== BigInt(transfer.size) || chunk.mimeType !== transfer.mimeType)) {
      this.#forget(transfer);
      transfer = undefined;
    }

    if (!transfer && chunk.offset !== 0n) return;
    const size = (transfer?.size ?? 0) + chunk.data.length;
    const capacity = transfer?.buffer.length ?? 0;
    // Charge the replacement while the old allocation still exists. Tiny
    // fragments share one buffer; memory does not scale with fragment count.
    const allocation = size > capacity ? Math.min(THREAD_BLOB_BYTES, Math.max(size, capacity * 2, 4096)) : 0;

    if (size > THREAD_BLOB_BYTES || !this.#fits(connection.workerId, allocation, !transfer)) {
      if (transfer) this.#forget(transfer);

      return;
    }

    transfer ??= this.#start(connection, key, chunk.mimeType);

    if (allocation) {
      const buffer = Buffer.allocUnsafeSlow(allocation);
      transfer.buffer.copy(buffer, 0, 0, transfer.size);
      transfer.buffer = buffer;
    }

    transfer.buffer.set(chunk.data, transfer.size);
    transfer.size = size;

    if (!chunk.last) return;
    transfer.complete = true;
    clearTimeout(transfer.timer);

    try {
      await store(transfer.buffer.subarray(0, size));
    } finally {
      this.#forget(transfer);
    }
  }

  #start(connection: Source, key: string, mimeType: string) {
    const entries = this.#pending.get(connection) ?? new Map<string, Transfer>();
    this.#pending.set(connection, entries);

    if (!this.#observed.has(connection)) {
      this.#observed.add(connection);
      void connection.closed.then(() => {
        for (const upload of this.#pending.get(connection)?.values() ?? []) {
          if (!upload.complete) this.#forget(upload);
        }
      });
    }

    const upload: Transfer = {
      connection,
      key,
      mimeType,
      buffer: Buffer.alloc(0),
      size: 0,
      complete: false,
      timer: setTimeout(() => this.#forget(upload), this.deadlineMs),
    };

    upload.timer.unref();
    entries.set(key, upload);
    this.#transfers.add(upload);

    return upload;
  }

  #fits(workerId: string, additional: number, newTransfer: boolean): boolean {
    let allBytes = additional;
    let workerBytes = additional;
    let workerFiles = Number(newTransfer);

    for (const transfer of this.#transfers) {
      allBytes += transfer.buffer.length;

      if (transfer.connection.workerId === workerId) {
        workerBytes += transfer.buffer.length;
        workerFiles++;
      }
    }

    return (
      this.#transfers.size + Number(newTransfer) <= GATEWAY_FILES &&
      allBytes <= GATEWAY_BYTES &&
      workerFiles <= WORKER_FILES &&
      workerBytes <= WORKER_BYTES
    );
  }

  #forget(transfer: Transfer) {
    clearTimeout(transfer.timer);
    this.#transfers.delete(transfer);
    const entries = this.#pending.get(transfer.connection);
    entries?.delete(transfer.key);

    if (!entries?.size) this.#pending.delete(transfer.connection);
  }
}

/** Every worker link in this process draws from the same allocation budget. */
export const previewBuffers = new PreviewBuffers();
