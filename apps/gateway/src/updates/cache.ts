import { mkdtemp, mkdir, open, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";
import { ReleaseMirror, type ReleaseSource } from "@canopy/updater";

/** One cache selection for every mirrored version; temporary storage is private to this process. */
export class UpdateCache {
  directory: string;
  #ready: Promise<void> | undefined;
  #temporary: string | undefined;
  constructor(
    directory = process.env["CANOPY_UPDATE_CACHE_DIR"] ||
      join(process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "canopy", "releases"),
    readonly log: (message: string) => void = console.warn,
    readonly temporaryRoot = tmpdir(),
  ) {
    this.directory = directory;
  }
  prepare(): Promise<void> {
    return (this.#ready ??= this.#prepare().catch((cause: unknown) => {
      this.#ready = undefined;
      throw cause;
    }));
  }
  async #prepare(): Promise<void> {
    try {
      await writable(this.directory);

      return;
    } catch {
      // HOME/XDG and explicit overrides may be read-only in a service or container.
    }

    try {
      this.#temporary = await mkdtemp(join(this.temporaryRoot, "canopy-releases-"));
      await writable(this.#temporary);
    } catch {
      throw new ConnectError(
        `Can't store update files: ${this.directory} is not writable and temporary storage is unavailable`,
        Code.FailedPrecondition,
      );
    }

    this.log(`Update cache ${this.directory} is not writable; using temporary cache ${this.#temporary}`);
    this.directory = this.#temporary;
  }
  close(): void {
    if (this.#temporary) rmSync(this.#temporary, { recursive: true, force: true });
  }
}

async function writable(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const probe = join(directory, `.write-${crypto.randomUUID()}`);
  const file = await open(probe, "wx", 0o600);

  try {
    await file.writeFile("cache probe");
  } finally {
    await file.close();
    await rm(probe, { force: true });
  }
}

/** Convert upstream and disk failures to actionable, safe RPC errors at the update boundary. */
export class GatewayReleaseMirror extends ReleaseMirror {
  constructor(
    readonly cache: UpdateCache,
    version: string,
    source: ReleaseSource,
  ) {
    super(cache.directory, version, source);
  }
  override get directory(): string {
    return this.cache.directory;
  }
  override manifest() {
    return this.#run(() => super.manifest());
  }
  override remember(value: Parameters<ReleaseMirror["remember"]>[0]) {
    return this.#run(() => super.remember(value));
  }
  override artifact(os: string, arch: string) {
    return this.#run(() => super.artifact(os, arch));
  }
  async #run<A>(run: () => Promise<A>): Promise<A> {
    await this.cache.prepare();

    try {
      return await run();
    } catch (cause) {
      if (cause instanceof ConnectError) throw cause;
      throw new ConnectError(
        `Can't prepare update release ${this.version}. Check the release source and write access to ${this.directory}`,
        Code.FailedPrecondition,
      );
    }
  }
}
