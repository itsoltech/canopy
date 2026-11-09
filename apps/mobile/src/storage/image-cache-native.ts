import { Directory, File, Paths } from "expo-file-system";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { imageScopeKey, ImmutableImageCache, type CachedImage, type ImageStorage } from "./image-cache";

export const imageDigest = (value: string) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value);
const markerName = /^(\d+)-([a-f0-9]{64})\.lru$/;

/** Data paths stay stable when LRU markers move, including while a native Image decodes a file. */
class NativeImageStorage implements ImageStorage {
  #markers = new Map<string, File>();
  #time = Date.now();

  constructor(readonly directory: Directory) {}

  async list(): Promise<CachedImage[]> {
    if (!this.directory.exists) return [];
    this.#markers.clear();
    const files = this.directory.list();
    const entries = new Map<string, CachedImage>();

    for (const marker of files) {
      const match = markerName.exec(marker.name);

      if (!(marker instanceof File) || !match) continue;
      const key = match[2]!;
      const accessed = Number(match[1]);
      const data = new File(this.directory, `${key}.bin`);
      this.#time = Math.max(this.#time, accessed);

      if (!data.exists || (entries.get(key)?.accessed ?? -1) >= accessed) continue;
      this.#markers.set(key, marker);
      entries.set(key, { key, uri: data.uri, bytes: data.size, accessed });
    }

    const kept = new Set([...entries.keys()].map((key) => `${key}.bin`));

    for (const marker of this.#markers.values()) kept.add(marker.name);

    for (const file of files) if (!kept.has(file.name)) file.delete();

    return [...entries.values()];
  }

  async exists(image: CachedImage) {
    const file = new File(this.directory, `${image.key}.bin`);

    return file.exists && file.size === image.bytes;
  }

  async write(key: string, data: Uint8Array) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid private image key");
    this.directory.create({ intermediates: true, idempotent: true });
    const pending = new File(this.directory, "pending");
    await pending.write(data);
    const file = new File(this.directory, `${key}.bin`);
    await pending.move(file, { overwrite: true });
    const image = { key, uri: file.uri, bytes: data.length, accessed: this.#next() };
    await this.touch(image);

    return image;
  }

  async touch(image: CachedImage) {
    const marker = new File(this.directory, `${this.#next()}-${image.key}.lru`);
    marker.create();
    const previous = this.#markers.get(image.key);

    if (previous?.exists) previous.delete();
    this.#markers.set(image.key, marker);
  }

  async remove(image: CachedImage) {
    const file = new File(this.directory, `${image.key}.bin`);

    if (file.exists) file.delete();
    const marker = this.#markers.get(image.key);

    if (marker?.exists) marker.delete();
    this.#markers.delete(image.key);
  }

  async clear() {
    this.#markers.clear();

    if (this.directory.exists) this.directory.delete();
  }

  #next() {
    this.#time = Math.max(Date.now(), this.#time + 1);

    return this.#time;
  }
}

/** Device ids are owner-bound. Neither identifiers nor credentials appear in private filenames. */
export async function prepareImageCache(session: { deviceId: string; fingerprint: string } | null) {
  const root = new Directory(Paths.cache, "images-v1");
  root.create({ intermediates: true, idempotent: true });
  const scope = session ? await imageDigest(imageScopeKey(session)) : "";

  for (const entry of root.list()) if (entry.name !== scope) entry.delete();

  return session ? new ImmutableImageCache(new NativeImageStorage(new Directory(root, scope)), imageDigest) : null;
}
