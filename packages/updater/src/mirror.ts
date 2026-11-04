import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { downloadAsset, writeVerified } from "./binary.ts";
import { parseManifest, releaseAsset, type ReleaseManifest, type ReleaseSource } from "./release.ts";

/** Content-addressed disk cache + in-flight deduplication. Never serves unchecked cached bytes. */
export class ReleaseMirror {
  readonly #inflight = new Map<string, Promise<string>>();
  #manifest: Promise<ReleaseManifest> | undefined;
  constructor(
    private readonly cacheDirectory: string,
    readonly version: string,
    readonly source: ReleaseSource,
  ) {}
  get directory(): string {
    return this.cacheDirectory;
  }
  manifest(): Promise<ReleaseManifest> {
    return (this.#manifest ??= this.#loadManifest().catch((error) => {
      this.#manifest = undefined;
      throw error;
    }));
  }
  async #loadManifest(): Promise<ReleaseManifest> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `manifest-${encodeURIComponent(this.version)}.json`);

    try {
      const manifest = parseManifest(JSON.parse(await readFile(path, "utf8")), this.source.options);

      if (manifest.version === this.version) return manifest;
    } catch {
      /* absent or invalid cache: resolve the authoritative manifest again */
    }

    const manifest = await this.source.version(this.version);
    await this.remember(manifest);

    return manifest;
  }
  /** Preserve the selected manifest before restarting, including nightly versions subject to retention. */
  async remember(value: ReleaseManifest): Promise<void> {
    const manifest = parseManifest(value, this.source.options);

    if (manifest.version !== this.version) throw new Error("Mirror manifest must match the gateway version");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `manifest-${encodeURIComponent(this.version)}.json`);
    const next = `${path}.${crypto.randomUUID()}.tmp`;

    try {
      await Bun.write(next, JSON.stringify(manifest), { mode: 0o600 });
      await rename(next, path);
    } finally {
      await rm(next, { force: true });
    }
  }
  artifact(os: string, arch: string): Promise<string> {
    const key = `${os}/${arch}`;
    const existing = this.#inflight.get(key);

    if (existing) return existing;
    const promise = this.#artifact(os, arch).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);

    return promise;
  }
  async #artifact(os: string, arch: string): Promise<string> {
    const asset = releaseAsset(await this.manifest(), "worker", os, arch);
    const path = join(this.directory, asset.sha256.toLowerCase());

    try {
      const file = Bun.file(path);

      if (file.size === asset.size) {
        const hash = createHash("sha256");

        for await (const chunk of file.stream()) hash.update(chunk);

        if (hash.digest("hex") === asset.sha256.toLowerCase()) return path;
      }
    } catch {
      /* missing cache file */
    }

    await rm(path, { force: true });
    const next = `${path}.${crypto.randomUUID()}.part`;

    try {
      await writeVerified(next, asset, downloadAsset(asset, this.source.options));
      await rename(next, path);
    } finally {
      await rm(next, { force: true });
    }

    return path;
  }
}
