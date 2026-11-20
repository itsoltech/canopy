import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { forModel, ImageError, MAX_SOURCE_BYTES, type NormalizedImage } from "./normalize.ts";
import { pinImageRoot } from "./export-root.ts";

/**
 * The platform's view_image tool on the worker (docs/agent-bus.md, "view_image"): an image from the thread's
 * working directory or its attachments, scaled for any model. Paths are resolved (symlinks included) before the
 * check, so `..` or a link cannot reach outside those directories.
 */

export interface ViewImageScope {
  /** The thread's working directory (relative paths start here). */
  readonly cwd: string;
  /** Directories the image may come from: the working directory and the thread's attachments. */
  readonly roots: readonly string[];
}

export interface ViewedImage extends NormalizedImage {
  /** The resolved path that was read. */
  readonly path: string;
}

export async function viewImage(path: string, scope: ViewImageScope): Promise<ViewedImage> {
  const { data, real } = readScopedImage(path, scope);

  return { ...(await forModel(data)), path: real };
}

export function readScopedImage(path: string, scope: ViewImageScope) {
  const requested = isAbsolute(path) ? path : resolve(scope.cwd, path);
  let real: string;

  try {
    real = realpathSync(requested);
  } catch {
    throw new ImageError(`${path} does not exist`);
  }

  const roots = scope.roots.flatMap((root) => {
    try {
      return [pinImageRoot(root)];
    } catch {
      return [];
    }
  });

  const root = roots.find((root) => real !== root.canonical && within(real, root.canonical));

  if (!root) throw new ImageError(`${path} is outside the thread's working directory and its attachments`);

  if (process.platform === "win32" && real.slice(2).includes(":"))
    throw new ImageError(`${path} is not a regular file`);
  const file = root.open(relative(root.canonical, real).split(sep));

  try {
    const stat = file.stat();

    if (!stat.regular || stat.links !== 1 || !within(file.path(), root.canonical))
      throw new ImageError(`${path} is not a regular file in the workspace`);

    if (stat.size <= 0 || stat.size > MAX_SOURCE_BYTES)
      throw new ImageError(`${path} exceeds the supported image size`);
    const data = Buffer.alloc(stat.size);

    for (let offset = 0; offset < data.length;) {
      const size = file.read(data, offset, data.length - offset, offset);

      if (!size) throw new ImageError("The image changed while it was being read");
      offset += size;
    }

    const after = file.stat();
    root.verify();

    if (after.size !== stat.size || after.version !== stat.version || !within(file.path(), root.canonical))
      throw new ImageError("The image changed while it was being read");

    return { data, real };
  } finally {
    file.close();
  }
}

export function within(path: string, root: string): boolean {
  const rel = relative(root, path);

  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** A regular file of at most `max` bytes. */
export function readLimited(path: string, max: number): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));

  try {
    const stat = fstatSync(fd);

    if (!stat.isFile()) throw new ImageError(`${path} is not a file`);

    if (stat.size > max) throw new ImageError(`${path} is larger than ${Math.round(max / 1024 ** 2)} MB`);
    const data = new Uint8Array(stat.size);
    let read = 0;

    while (read < stat.size) {
      const n = readSync(fd, data, read, stat.size - read, read);

      if (n === 0) break;
      read += n;
    }

    return data.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}
