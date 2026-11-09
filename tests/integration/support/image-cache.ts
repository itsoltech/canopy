import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CachedImage, ImageStorage } from "../../../apps/mobile/src/storage/image-cache.ts";

export const imageHash = async (key: string) => createHash("sha256").update(key).digest("hex");

/** A real private filesystem adapter for the shared cache state machine; no Expo runtime in Bun. */
export class DiskImageStorage implements ImageStorage {
  #time = Date.now();

  constructor(readonly directory: string) {}

  async list() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const images: CachedImage[] = [];

    for (const key of await readdir(this.directory)) {
      const info = await stat(join(this.directory, key));
      images.push({
        key,
        bytes: info.size,
        accessed: info.mtimeMs,
        uri: pathToFileURL(join(this.directory, key)).href,
      });
    }

    return images;
  }

  async exists(image: CachedImage) {
    try {
      return (await stat(join(this.directory, image.key))).size === image.bytes;
    } catch {
      return false;
    }
  }

  async write(key: string, data: Uint8Array) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid test image key");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, key);
    await writeFile(path, data, { mode: 0o600 });
    const image = { key, bytes: data.length, accessed: ++this.#time, uri: pathToFileURL(path).href };
    await this.touch(image);

    return image;
  }

  async touch(image: CachedImage) {
    const now = new Date(++this.#time);
    await utimes(join(this.directory, image.key), now, now);
  }

  async remove(image: CachedImage) {
    await rm(join(this.directory, image.key), { force: true });
  }

  clear() {
    return rm(this.directory, { recursive: true, force: true });
  }

  read(uri: string) {
    return readFile(new URL(uri));
  }
}
