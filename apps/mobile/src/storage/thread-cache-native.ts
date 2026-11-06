import { Directory, File, Paths } from "expo-file-system";
import { PersistentThreadCache, type CacheFile, type ThreadCacheStorage } from "./thread-cache";

const filename = /^(\d+)-([a-z0-9_~-]+)\.bin$/;

class NativeThreadStorage implements ThreadCacheStorage {
  #time = Date.now();
  constructor(readonly directory: Directory) {}

  async list(): Promise<CacheFile[]> {
    if (!this.directory.exists) return [];

    return this.directory.list().flatMap((file) => {
      const match = filename.exec(file.name);

      if (!(file instanceof File) || !match) {
        file.delete();

        return [];
      }

      this.#time = Math.max(this.#time, Number(match[1]));

      return [{ name: file.name, accessed: Number(match[1]), id: match[2]!, bytes: file.size }];
    });
  }

  read(name: string) {
    return new File(this.directory, name).bytes();
  }

  async write(id: string, bytes: Uint8Array) {
    this.directory.create({ idempotent: true, intermediates: true });
    const temp = new File(this.directory, "pending");
    await temp.write(bytes);
    await temp.move(new File(this.directory, this.#name(id)), { overwrite: true });
  }

  async touch(name: string, id: string) {
    const destination = this.#name(id);

    if (destination !== name)
      await new File(this.directory, name).move(new File(this.directory, destination), { overwrite: true });
  }

  async remove(name: string) {
    const file = new File(this.directory, name);

    if (file.exists) file.delete();
  }

  async clear() {
    if (this.directory.exists) this.directory.delete();
  }

  #name(id: string) {
    this.#time = Math.max(Date.now(), this.#time + 1);

    return `${this.#time}-${id}.bin`;
  }
}

/** Device id and pinned certificate isolate pairings; orphaned scopes are removed before mounting screens. */
export async function prepareThreadCache(session: { deviceId: string; fingerprint: string } | null) {
  const storage = await prepareSnapshotStorage("thread-snapshots-v1", session);

  return storage ? new PersistentThreadCache(storage) : null;
}

/** Both caches use the existing app-private atomic file adapter, with independent versioned namespaces. */
export async function prepareSnapshotStorage(
  namespace: string,
  session: { deviceId: string; fingerprint: string } | null,
) {
  const parent = new Directory(Paths.cache, namespace);
  parent.create({ idempotent: true, intermediates: true });
  const scope = session ? `${session.deviceId}-${session.fingerprint}` : "";

  if (scope && !/^[a-f0-9-]+$/.test(scope)) throw new Error("Invalid cache pairing");

  for (const entry of parent.list()) if (entry.name !== scope) entry.delete();

  return session ? new NativeThreadStorage(new Directory(parent, scope)) : null;
}
