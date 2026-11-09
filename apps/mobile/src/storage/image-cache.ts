export interface CachedImage {
  readonly key: string;
  readonly uri: string;
  readonly bytes: number;
  readonly accessed: number;
}

export interface ImageStorage {
  list(): Promise<CachedImage[]>;
  exists(image: CachedImage): Promise<boolean>;
  write(key: string, data: Uint8Array): Promise<CachedImage>;
  touch(image: CachedImage): Promise<void>;
  remove(image: CachedImage): Promise<void>;
  clear(): Promise<void>;
}

export const imageCacheLimits = { memory: 24 * 1024 ** 2, disk: 200 * 1024 ** 2, count: 2048 };
export const imageCancelled = () => Object.assign(new Error("Image request cancelled"), { name: "AbortError" });

export const imageScopeKey = (session: { deviceId: string; fingerprint: string }) =>
  JSON.stringify([session.deviceId, session.fingerprint]);

interface Flight {
  readonly controller: AbortController;
  readonly promise: Promise<string>;
  users: number;
}

/** One pairing owns this cache. Only file URIs remain in memory; downloaded byte arrays are released. */
export class ImmutableImageCache {
  #memory = new Map<string, CachedImage>();
  #flights = new Map<string, Flight>();
  #memoryBytes = 0;
  #closed = false;
  #work: Promise<void> = Promise.resolve();

  constructor(
    readonly storage: ImageStorage,
    readonly hash: (key: string) => Promise<string>,
    readonly limits = imageCacheLimits,
  ) {}

  usage() {
    return { memoryBytes: this.#memoryBytes, memoryEntries: this.#memory.size, inFlight: this.#flights.size };
  }

  /** Retry after a decoder failure must replace a damaged file, even if its size is unchanged. */
  async invalidate(key: string) {
    const hashed = await this.hash(key);
    await this.#serial(async () => {
      this.#drop(hashed);
      const image = (await this.storage.list()).find((entry) => entry.key === hashed);

      if (image) await this.storage.remove(image);
    });
  }

  get(key: string, read: (signal: AbortSignal) => Promise<Uint8Array>, signal: AbortSignal): Promise<string> {
    if (this.#closed || signal.aborted) return Promise.reject(imageCancelled());
    let flight = this.#flights.get(key);

    if (!flight) {
      const controller = new AbortController();
      flight = { controller, promise: this.#load(key, read, controller.signal), users: 0 };
      this.#flights.set(key, flight);
      const current = flight;

      const clear = () => {
        if (this.#flights.get(key) === current) this.#flights.delete(key);
      };

      void flight.promise.then(clear, clear);
    }

    return this.#subscribe(key, flight, signal);
  }

  /** Fence callbacks synchronously, then remove private files after any already-started disk operation. */
  close(): Promise<void> {
    this.#closed = true;

    for (const flight of this.#flights.values()) flight.controller.abort();
    this.#flights.clear();
    this.#memory.clear();
    this.#memoryBytes = 0;

    return this.#serial(() => this.storage.clear());
  }

  #subscribe(key: string, flight: Flight, signal: AbortSignal) {
    flight.users++;

    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const finish = () => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener("abort", cancel);

        if (--flight.users === 0) {
          flight.controller.abort();

          if (this.#flights.get(key) === flight) this.#flights.delete(key);
        }

        return true;
      };

      const cancel = () => {
        if (finish()) reject(imageCancelled());
      };

      signal.addEventListener("abort", cancel, { once: true });
      flight.promise.then(
        (uri) => {
          if (finish()) resolve(uri);
        },
        (error) => {
          if (finish()) reject(error);
        },
      );

      if (signal.aborted) cancel();
    });
  }

  async #load(key: string, read: (signal: AbortSignal) => Promise<Uint8Array>, signal: AbortSignal) {
    const hashed = await this.hash(key);

    const ensureActive = () => {
      if (this.#closed || signal.aborted) throw imageCancelled();
    };

    const cached = await this.#serial(async () => {
      ensureActive();
      const memory = this.#memory.get(hashed);
      const entries = memory ? undefined : await this.#trim();
      const image = memory ?? entries?.find((entry) => entry.key === hashed);

      if (!image) return;

      if (!(await this.storage.exists(image))) {
        this.#drop(hashed);
        await this.storage.remove(image);

        return;
      }

      await this.storage.touch(image);
      ensureActive();
      this.#remember(image);

      return image.uri;
    });

    if (cached) return cached;
    ensureActive();
    const data = await read(signal);
    ensureActive();

    return this.#serial(async () => {
      ensureActive();

      if (!data.length || data.length > this.limits.disk) throw new Error("Image exceeds the private cache budget");
      await this.#trim(data.length, 1);
      ensureActive();
      const image = await this.storage.write(hashed, data);
      ensureActive();
      this.#remember(image);

      return image.uri;
    });
  }

  async #trim(incoming = 0, count = 0) {
    const entries = (await this.storage.list()).sort((a, b) => b.accessed - a.accessed);
    const kept: CachedImage[] = [];
    let bytes = incoming;

    for (const image of entries) {
      if (bytes + image.bytes > this.limits.disk || kept.length + count >= this.limits.count) {
        this.#drop(image.key);
        await this.storage.remove(image);
      } else {
        bytes += image.bytes;
        kept.push(image);
      }
    }

    return kept;
  }

  #remember(image: CachedImage) {
    this.#drop(image.key);

    if (image.bytes > this.limits.memory) return;
    this.#memory.set(image.key, image);
    this.#memoryBytes += image.bytes;

    while (this.#memoryBytes > this.limits.memory) {
      const oldest = this.#memory.keys().next().value;

      if (oldest === undefined) break;
      this.#drop(oldest);
    }
  }

  #drop(key: string) {
    this.#memoryBytes -= this.#memory.get(key)?.bytes ?? 0;
    this.#memory.delete(key);
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#work.then(run, run);
    this.#work = next.then(
      () => {},
      () => {},
    );

    return next;
  }
}
