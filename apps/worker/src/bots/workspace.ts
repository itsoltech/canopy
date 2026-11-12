import { constants, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

export const BOT_FILE_BYTES = 50 * 1024 ** 2;
export const BOT_WORKSPACE_BYTES = 200 * 1024 ** 2;
export const BOT_WORKSPACE_FILES = 256;
export const BOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const active = new Set<string>();

export class BotFileError extends Error {}

/** Flat names keep untrusted paths out of parent-directory resolution on every platform. */
export function botFilename(name: string): string {
  if (
    !name ||
    name.length > 180 ||
    name.startsWith(".") ||
    // oxlint-disable-next-line no-control-regex -- file names exclude control bytes on all supported platforms
    /[\\/\x00-\x1f\x7f:]/.test(name) ||
    name.endsWith(".") ||
    name.endsWith(" ") ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)
  )
    throw new BotFileError("Use a filename without folders, traversal or special characters.");

  return name;
}

/** No harness can mutate this directory directly; only these bounded platform operations can. */
export class BotWorkspace {
  constructor(readonly path: string) {
    this.checkRoot();
  }
  checkRoot(): void {
    const stat = lstatSync(this.path);

    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BotFileError("Bot workspace is unavailable.");
  }
  hold(): () => void {
    active.add(this.path);
    this.touch();

    return () => {
      active.delete(this.path);
      this.touch();
    };
  }
  touch(): void {
    this.checkRoot();
    const now = new Date();
    utimesSync(this.path, now, now);
  }
  list() {
    this.checkRoot();

    return readdirSync(this.path)
      .filter((name) => !name.startsWith("."))
      .map((name) => {
        botFilename(name);
        const stat = lstatSync(join(this.path, name));

        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw new BotFileError("Workspace contains an unsupported file.");

        return { name, size_bytes: stat.size };
      });
  }
  async read(name: string, limit = BOT_FILE_BYTES): Promise<Buffer> {
    this.checkRoot();
    const metadata = lstatSync(join(this.path, botFilename(name)));

    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
      throw new BotFileError("Choose a regular file in this conversation workspace.");

    const file = await open(
      join(this.path, botFilename(name)),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );

    try {
      const stat = await file.stat();

      if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
        throw new BotFileError("Choose a regular file within the file size limit.");
      const data = Buffer.alloc(stat.size);
      let offset = 0;

      while (offset < data.length) {
        const read = await file.read(data, offset, data.length - offset, offset);

        if (!read.bytesRead) throw new BotFileError("The file changed. Try again.");
        offset += read.bytesRead;
      }

      const after = await file.stat();

      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
        throw new BotFileError("The file changed. Try again.");

      return data;
    } finally {
      await file.close();
    }
  }
  write(name: string, data: Uint8Array) {
    botFilename(name);
    const files = this.list();
    const previous = files.find((f) => f.name === name);

    if (data.byteLength > BOT_FILE_BYTES) throw new BotFileError("Files can be up to 50 MiB.");

    if (
      (!previous && files.length >= BOT_WORKSPACE_FILES) ||
      files.reduce((n, f) => n + f.size_bytes, 0) + data.byteLength > BOT_WORKSPACE_BYTES
    )
      throw new BotFileError("The conversation workspace is full. Use a smaller file.");
    const temporary = join(this.path, `.write-${crypto.randomUUID()}`);

    try {
      writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
      renameSync(temporary, join(this.path, name));
      this.touch();
    } finally {
      rmSync(temporary, { force: true });
    }

    return { name, size_bytes: data.byteLength };
  }
  delete(name: string) {
    this.list();
    rmSync(join(this.path, botFilename(name)));
    this.touch();

    return { name, deleted: true };
  }
}

/** Retention never follows symlinks or removes a workspace held by a live harness. */
export function cleanupBotWorkspaces(dataDir: string, now = Date.now()): void {
  const root = join(dataDir, "bots");
  mkdirSync(root, { recursive: true, mode: 0o700 });

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
    const path = join(root, entry.name, "workspace");

    if (active.has(path)) continue;

    try {
      const stat = lstatSync(path);

      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;

      if (now - stat.mtimeMs > BOT_RETENTION_MS) rmSync(path, { recursive: true });
      else
        for (const file of readdirSync(path)) {
          if (file.startsWith(".write-")) rmSync(join(path, file), { force: true });
        }
    } catch {
      // A missing or concurrently removed workspace needs no cleanup.
    }
  }
}
