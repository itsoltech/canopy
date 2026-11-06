import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { ThreadCache } from "@canopy/domain/thread-cache";

export interface CacheFile {
  name: string;
  id: string;
  accessed: number;
  bytes: number;
}

/** App-private files; writes replace atomically, and list never includes partial writes. */
export interface ThreadCacheStorage {
  list(): Promise<CacheFile[]>;
  read(name: string): Promise<Uint8Array>;
  write(id: string, bytes: Uint8Array): Promise<void>;
  touch(name: string, id: string): Promise<void>;
  remove(name: string): Promise<void>;
  clear(): Promise<void>;
}

export const cacheLimits = { count: 16, bytes: 64 * 1024 * 1024, entry: 16 * 1024 * 1024 };

/** Shared unpair/revocation path; close fences stream callbacks before either deletion awaits I/O. */
export async function clearPairingCache(cache: PersistentThreadCache | null, forget: () => Promise<void>) {
  const results = await Promise.allSettled([cache?.close(), forget()]);

  return results.every((result) => result.status === "fulfilled");
}

/** Pairing lifetime fence plus serialized disk work: a late stream cannot resurrect revoked data. */
export class PersistentThreadCache {
  #memory = new ThreadCache({ count: 6, bytes: 24 * 1024 * 1024 });
  #writing: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    readonly storage: ThreadCacheStorage,
    readonly limits = cacheLimits,
  ) {}

  peek(id: string) {
    return this.#closed ? undefined : this.#memory.get(id);
  }

  load(id: string): Promise<ui.ThreadSnapshot | undefined> {
    return this.#serial(async () => {
      if (this.#closed) return undefined;
      const cached = this.peek(id);
      const entries = await this.#trim();
      const entry = entries.find((file) => file.id === id);

      if (cached) {
        if (entry) await this.storage.touch(entry.name, id);

        return cached;
      }

      if (!entry) return undefined;

      try {
        const bytes = await this.storage.read(entry.name);
        const snapshot = fromBinary(ui.ThreadSnapshotSchema, bytes);

        if (snapshot.thread?.id !== id || snapshot.thread.deletedAt) throw new Error("Invalid cached thread");

        if (this.#closed) return undefined;
        this.#memory.set(snapshot, bytes.byteLength);
        await this.storage.touch(entry.name, id);

        return snapshot;
      } catch {
        await this.storage.remove(entry.name);

        return undefined;
      }
    });
  }

  save(snapshot: ui.ThreadSnapshot): Promise<void> {
    if (this.#closed || !snapshot.thread) return Promise.resolve();
    const bytes = toBinary(ui.ThreadSnapshotSchema, snapshot);
    this.#memory.set(snapshot, bytes.byteLength);

    return this.#serial(async () => {
      if (this.#closed) return;
      const id = snapshot.thread!.id;
      const previous = (await this.storage.list()).filter((file) => file.id === id);

      if (!snapshot.thread!.deletedAt && bytes.byteLength <= this.limits.entry && bytes.byteLength <= this.limits.bytes)
        await this.storage.write(id, bytes);

      for (const entry of previous) await this.storage.remove(entry.name);
      await this.#trim();
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#memory.clear();

    return this.#serial(() => this.storage.clear());
  }

  async #trim() {
    const entries = (await this.storage.list()).sort((a, b) => b.accessed - a.accessed);
    const kept: CacheFile[] = [];
    let bytes = 0;

    for (const entry of entries) {
      if (
        entry.bytes > this.limits.entry ||
        kept.length >= this.limits.count ||
        bytes + entry.bytes > this.limits.bytes ||
        kept.some((file) => file.id === entry.id)
      )
        await this.storage.remove(entry.name);
      else {
        kept.push(entry);
        bytes += entry.bytes;
      }
    }

    return kept;
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#writing.then(run, run);
    this.#writing = next.then(
      () => {},
      () => {},
    );

    return next;
  }
}
