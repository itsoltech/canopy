import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, cp, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DesktopStatus } from "@canopy/ui/desktop";

// SAFETY: Our repository-owned CommonJS packaging module exports this two-string entry point.
const { preparePostgres } = require("../../scripts/postgres.cjs") as {
  preparePostgres(directory: string, target: string): void;
};

export interface PostgresPin {
  packageName: string;
  version: string;
  major: number;
  target: string;
  integrity: string;
}

function isPostgresPin(value: unknown): value is PostgresPin {
  return (
    !!value &&
    typeof value === "object" &&
    "packageName" in value &&
    typeof value.packageName === "string" &&
    "version" in value &&
    typeof value.version === "string" &&
    "major" in value &&
    typeof value.major === "number" &&
    "target" in value &&
    typeof value.target === "string" &&
    "integrity" in value &&
    typeof value.integrity === "string"
  );
}

function isInstalledMarker(value: unknown): value is Pick<PostgresPin, "integrity" | "target"> {
  return (
    !!value &&
    typeof value === "object" &&
    "integrity" in value &&
    typeof value.integrity === "string" &&
    "target" in value &&
    typeof value.target === "string"
  );
}

export type DatabaseProgress = NonNullable<DesktopStatus["database"]>;

export interface PostgresTestOptions {
  registry: string;
}

const MAX_DOWNLOAD = 512 * 1024 ** 2;
const versionEntry = /^\d+\.\d+\.\d+(?:-[\w.]+)?-(?:linux|darwin|win32)-/;

class DownloadError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

async function integrity(path: string) {
  const hash = createHash("sha512");

  for await (const chunk of createReadStream(path)) hash.update(chunk);

  return `sha512-${hash.digest("base64")}`;
}

/** Test URLs cannot arrive through UI, remote config, or a production environment. */
export function postgresTestOptions(env: NodeJS.ProcessEnv = process.env): PostgresTestOptions | undefined {
  return env["NODE_ENV"] === "test" && env["CANOPY_TEST_POSTGRES_REGISTRY"]
    ? { registry: env["CANOPY_TEST_POSTGRES_REGISTRY"] }
    : undefined;
}

export class PostgresInstaller {
  readonly pin: PostgresPin;
  readonly directory: string;
  readonly #versions: string;
  readonly #key: string;
  readonly #url: string;

  constructor(
    manifest: string,
    readonly dataDirectory: string,
    private readonly progress: (value: DatabaseProgress) => void = () => {},
    testing?: PostgresTestOptions,
  ) {
    const value: unknown = JSON.parse(readFileSync(manifest, "utf8"));

    if (!isPostgresPin(value)) throw new Error("Invalid PostgreSQL distribution pin");
    this.pin = value;
    const pin = this.pin;

    if (
      pin.target !== `${process.platform}-${process.arch}` ||
      pin.packageName !== `@embedded-postgres/${pin.target.replace("win32", "windows")}` ||
      !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(pin.version) ||
      pin.major !== Number(pin.version.split(".")[0]) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.integrity)
    )
      throw new Error("Invalid PostgreSQL distribution pin");
    this.#versions = join(dataDirectory, "versions");
    this.#key = `${pin.version}-${pin.target}-${createHash("sha256").update(pin.integrity).digest("hex").slice(0, 16)}`;
    this.directory = join(this.#versions, this.#key);
    const registry = new URL(testing?.registry ?? "https://registry.npmjs.org/");

    if (testing && (registry.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(registry.hostname)))
      throw new Error("Test registry must use loopback HTTP");
    const name = pin.packageName.split("/")[1]!;
    this.#url = new URL(`${pin.packageName}/-/${name}-${pin.version}.tgz`, registry).href;
  }

  #checkMajor(): void {
    const file = join(this.dataDirectory, "data/PG_VERSION");

    if (!existsSync(file)) return;
    const existing = readFileSync(file, "utf8").trim();

    if (existing !== String(this.pin.major))
      throw new Error(
        `This database uses PostgreSQL ${existing}; this app requires PostgreSQL ${this.pin.major}. Your database and any previous cached runtime have been kept. Use the previous app version, then back up and migrate the database before upgrading.`,
      );
  }

  #ready(): boolean {
    try {
      const marker: unknown = JSON.parse(readFileSync(join(this.directory, "installed.json"), "utf8"));

      if (!isInstalledMarker(marker)) return false;

      if (
        !lstatSync(this.directory).isDirectory() ||
        marker.integrity !== this.pin.integrity ||
        marker.target !== this.pin.target
      )
        return false;

      return ["postgres", "pg_ctl", "initdb"].every((name) => {
        const file = lstatSync(join(this.directory, "bin", name + (process.platform === "win32" ? ".exe" : "")));

        return file.isFile() && file.size > 0;
      });
    } catch {
      return false;
    }
  }

  async ensure(signal: AbortSignal): Promise<string> {
    this.#checkMajor(); // Before any network, cache deletion or access to the data with a new server.

    if (this.#ready()) return this.directory;
    mkdirSync(this.#versions, { recursive: true, mode: 0o700 });
    const download = join(this.#versions, `${this.#key}.download`);
    const archive = join(download, "package.tgz.partial");
    const extracted = join(download, "extracted");
    const stage = join(download, "install");
    await mkdir(download, { recursive: true, mode: 0o700 });

    try {
      await rm(extracted, { recursive: true, force: true });
      await rm(stage, { recursive: true, force: true });
      const complete = existsSync(archive) && (await integrity(archive)) === this.pin.integrity;
      this.progress({ phase: "downloading", message: `Downloading PostgreSQL ${this.pin.major}…` });

      if (!complete)
        for (let attempt = 0; ; attempt++) {
          try {
            await this.#download(archive, signal);
            break;
          } catch (error) {
            if (!(error instanceof DownloadError) || !error.retryable || attempt >= 2 || signal.aborted) throw error;
            await delay(250 * 2 ** attempt, undefined, { signal });
          }
        }

      signal.throwIfAborted();
      this.progress({ phase: "verifying", message: "Verifying the PostgreSQL download…" });

      if ((await integrity(archive)) !== this.pin.integrity) {
        await rm(download, { recursive: true, force: true });
        throw new DownloadError(
          "PostgreSQL SHA-512 integrity verification failed. No files were installed. Try again.",
        );
      }

      this.progress({ phase: "installing", message: "Setting up PostgreSQL…" });
      // Bun validates archive paths and symlink targets. Extract only the native
      // distribution and its license, never package scripts or dependencies.
      await new Bun.Archive(await Bun.file(archive).bytes()).extract(extracted, {
        glob: ["package/native/**", "package/LICENSE.md"],
      });
      await rename(join(extracted, "package/native"), stage);
      await cp(join(extracted, "package/LICENSE.md"), join(stage, "DISTRIBUTION-LICENSE.md"));
      signal.throwIfAborted();
      preparePostgres(stage, this.pin.target);

      for (const name of ["postgres", "pg_ctl", "initdb"]) {
        const path = join(stage, "bin", name + (process.platform === "win32" ? ".exe" : ""));

        if (!lstatSync(path).isFile()) throw new Error("PostgreSQL distribution contains an invalid executable");
        await chmod(path, 0o755);

        const child = Bun.spawn([path, "--version"], {
          stdout: "pipe",
          stderr: "pipe",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });

        const text = await new Response(child.stdout).text();

        if ((await child.exited) !== 0 || !new RegExp(`PostgreSQL\\)? ${this.pin.major}\\.`).test(text))
          throw new Error(
            "Downloaded PostgreSQL could not run on this computer. Check the desktop logs and OS security policy, then try again.",
          );
      }

      writeFileSync(
        join(stage, "installed.json"),
        JSON.stringify({ integrity: this.pin.integrity, target: this.pin.target }),
        { mode: 0o600 },
      );
      signal.throwIfAborted();
      await rm(this.directory, { recursive: true, force: true });
      await rename(stage, this.directory); // Completion marker and runtime become visible together.
      await rm(download, { recursive: true, force: true });
      this.progress({ phase: "ready", message: "PostgreSQL is ready. Starting local services…" });

      return this.directory;
    } catch (error) {
      if (signal.aborted) throw new Error("PostgreSQL setup was cancelled. The download can resume next time.");

      if (error instanceof DownloadError || (error instanceof Error && /PostgreSQL/.test(error.message))) throw error;
      throw new Error(
        "PostgreSQL could not be installed. Check your connection, available disk space and OS security policy, then try again.",
        { cause: error },
      );
    } finally {
      await rm(extracted, { recursive: true, force: true });
      await rm(stage, { recursive: true, force: true });
    }
  }

  /** Run only after the new server has started and any orphan was stopped. */
  cleanup(): void {
    if (!this.#ready()) return;

    for (const entry of readdirSync(this.#versions)) {
      if (versionEntry.test(entry) && entry !== this.#key)
        rmSync(join(this.#versions, entry), { recursive: true, force: true });
    }
  }

  async #download(path: string, abort: AbortSignal): Promise<void> {
    const offset = existsSync(path) ? lstatSync(path).size : 0;
    const signal = AbortSignal.any([abort, AbortSignal.timeout(120_000)]);
    let response: Response;

    try {
      response = await fetch(this.#url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal });
    } catch {
      throw new DownloadError(
        "PostgreSQL download could not reach the npm registry. Check your connection and try again.",
        true,
      );
    }

    if (response.status === 416 && offset) {
      await response.body?.cancel();
      await rm(path, { force: true });
      throw new DownloadError("PostgreSQL partial download needs to restart. Try again.", true);
    }

    if (![200, 206].includes(response.status) || !response.body) {
      await response.body?.cancel();
      throw new DownloadError(
        `PostgreSQL download returned HTTP ${response.status}. Try again.`,
        response.status >= 500 || response.status === 429,
      );
    }

    const resumed = response.status === 206;
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");

    if (resumed && (!range || Number(range[1]) !== offset || Number(range[3]) > MAX_DOWNLOAD)) {
      await response.body.cancel();
      await rm(path, { force: true });
      throw new DownloadError("PostgreSQL registry returned an invalid resume range. Try again.", true);
    }

    const handle = await open(path, resumed ? "a" : "w", 0o600);
    let size = resumed ? offset : 0;
    const length = Number(response.headers.get("content-length"));
    const total = range ? Number(range[3]) : length > 0 ? length : undefined;
    let previous = -1;

    try {
      for await (const chunk of response.body) {
        size += chunk.byteLength;

        if (size > MAX_DOWNLOAD) throw new DownloadError("PostgreSQL package exceeds the download size limit.");
        await handle.writeFile(chunk);
        const percent = total ? Math.min(100, Math.floor((size / total) * 100)) : undefined;

        if ((percent ?? 0) !== previous) {
          previous = percent ?? 0;
          this.progress({
            phase: "downloading",
            ...(percent !== undefined && { progress: percent }),
            // The bar shows the percentage; a steady line keeps the text from jumping as it changes.
            message: `Downloading PostgreSQL ${this.pin.major}. You need this download only once.`,
          });
        }
      }

      await handle.sync();
    } catch (error) {
      if (error instanceof DownloadError) throw error;
      throw new DownloadError("PostgreSQL download was interrupted. Try again to resume it.", true);
    } finally {
      await handle.close();
    }
  }
}
