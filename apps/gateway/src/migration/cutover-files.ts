import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export class CutoverError extends Error {}

export async function requirePrivateDirectory(directory: string, create = false) {
  if (create)
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    });

  const stat = await lstat(directory);

  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new CutoverError("Use a private cutover directory owned by the operator.");
}

export async function readCutoverFile<T>(path: string, decode: (value: string) => T, maxBytes = 1024 * 1024) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;

    return undefined;
  });

  if (!handle) return undefined;

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes)
      throw new CutoverError("Use private cutover files owned by the operator.");

    return decode(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

export async function syncCutoverDirectory(directory: string) {
  const handle = await open(directory, "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeCutoverFile(path: string, content: string) {
  const directory = dirname(path);
  const staging = await mkdtemp(join(directory, ".cutover-"));
  const temporary = join(staging, "state");

  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx", flush: true });
    await rename(temporary, path);
    await syncCutoverDirectory(directory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function withCutoverLock<T>(directory: string, use: () => Promise<T>): Promise<T> {
  await requirePrivateDirectory(directory);

  const handle = await open(
    join(directory, "cutover.lock"),
    constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );

  try {
    // flock acts on the inherited open file description. Our descriptor keeps it locked after flock exits.
    const child = spawn("flock", ["-n", "-x", "3"], { stdio: ["ignore", "ignore", "ignore", handle.fd] });

    const [code] = await once(child, "exit").catch(() => {
      throw new CutoverError("Install flock to run the gateway cutover coordinator.");
    });

    if (code !== 0) throw new CutoverError("Another cutover operation is running in this directory.");

    return await use();
  } finally {
    await handle.close();
  }
}

export async function requireStorageSpace(directory: string, required: bigint) {
  const fs = await statfs(directory, { bigint: true });

  if (fs.bavail * fs.bsize < required)
    throw new CutoverError("The cutover filesystem does not have enough available staging space.");
}
