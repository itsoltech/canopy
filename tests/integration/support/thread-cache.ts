import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadCacheStorage } from "../../../apps/mobile/src/storage/thread-cache.ts";

/** Real disk adapter for the cache's durability and pairing-lifetime tests. */
export class DiskThreadStorage implements ThreadCacheStorage {
  #time = Date.now();

  constructor(readonly directory: string) {}

  async list() {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory);

    return Promise.all(
      entries
        .filter((name) => name.endsWith(".bin"))
        .map(async (name) => ({
          name,
          id: name.slice(name.indexOf("-") + 1, -4),
          accessed: Number(name.slice(0, name.indexOf("-"))),
          bytes: (await stat(join(this.directory, name))).size,
        })),
    );
  }

  async read(name: string) {
    return new Uint8Array(await readFile(join(this.directory, name)));
  }

  async write(id: string, bytes: Uint8Array) {
    await mkdir(this.directory, { recursive: true });
    const name = this.#name(id);
    await writeFile(join(this.directory, "pending"), bytes);
    await rename(join(this.directory, "pending"), join(this.directory, name));
  }

  async touch(name: string, id: string) {
    await rename(join(this.directory, name), join(this.directory, this.#name(id)));
  }

  async remove(name: string) {
    await rm(join(this.directory, name), { force: true });
  }

  async clear() {
    await rm(this.directory, { recursive: true, force: true });
  }

  #name(id: string) {
    this.#time = Math.max(this.#time + 1, Date.now());

    return `${this.#time}-${id}.bin`;
  }
}
