import { clone, create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { RangeSourceStore } from "../computers/range-source.ts";
import { readClientWindow } from "./client-window.ts";

type CachedWindow = { size: number; value: ui.ThreadSnapshot };

// Each window has a 512 KiB record budget. Eight entries cap process-wide
// cached record payload at 4 MiB without serializing the window a second time.
const recentWindows = new Map<SequenceWindow, CachedWindow>();
const maxRecentWindows = 8;

/** Recent windows use a process-wide LRU; history pages are never cached here. */
export class SequenceWindow {
  #pending: { size: number; value: Promise<ui.ThreadSnapshot> } | undefined;
  #version = 0;
  #closed = false;
  constructor(readonly store: RangeSourceStore) {}

  invalidate() {
    recentWindows.delete(this);
    this.#version++;
  }

  async read(input: ui.WatchThreadRequest) {
    if (this.#closed) throw new ConnectError("Thread window is closed", Code.Canceled);

    if (input.beforeItemId || input.beforeTurnId || input.targetItemId || input.fromTurnId || input.historyVersion)
      return readClientWindow(this.store, input);
    const size = Math.max(1, Math.min(input.pageSize || 24, 100));
    const recent = recentWindows.get(this);

    if (recent?.size === size) {
      const clock = (
        await this.store.query<{ epoch: string; head: string }>(
          `SELECT c.epoch,c.head_seq::text AS head FROM thread_replication_clock c
          JOIN threads t ON t.id=c.thread_id WHERE c.thread_id=$1::uuid
            AND t.owner_user_id=$2::uuid AND t.deleted_at IS NULL`,
          [input.threadId, this.store.owner],
        )
      )[0];

      const cursor = recent.value.syncCursor;

      // Window creation checkpoints the head: any subsequent source edit must advance it.
      if (
        !this.#closed &&
        clock &&
        cursor &&
        clock.epoch === cursor.epoch &&
        BigInt(clock.head) === cursor.appliedSeq
      ) {
        recentWindows.delete(this);
        recentWindows.set(this, recent);

        return clone(ui.ThreadSnapshotSchema, recent.value);
      }

      this.invalidate();
    }

    // Different window sizes share one in-flight read slot per active thread.
    while (this.#pending && this.#pending.size !== size) await this.#pending.value;

    if (this.#closed) throw new ConnectError("Thread window is closed", Code.Canceled);
    let reading = this.#pending?.value;

    if (!reading) {
      const version = this.#version;

      reading = readClientWindow(this.store, create(ui.WatchThreadRequestSchema, { ...input, pageSize: size }))
        .then((value) => {
          if (!this.#closed && version === this.#version) {
            recentWindows.delete(this);
            recentWindows.set(this, { size, value });

            // SAFETY: An overflowing Map contains at least one key.
            while (recentWindows.size > maxRecentWindows) recentWindows.delete(recentWindows.keys().next().value!);
          }

          return value;
        })
        .finally(() => {
          this.#pending = undefined;
        });
      this.#pending = { size, value: reading };
    }

    return clone(ui.ThreadSnapshotSchema, await reading);
  }

  close() {
    this.#closed = true;
    this.invalidate();
    this.#pending = undefined;
  }
}
