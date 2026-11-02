import { openSync, closeSync, fstatSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { forModel, ImageError, MAX_SOURCE_BYTES, type NormalizedImage } from "./normalize.ts";

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
  const requested = isAbsolute(path) ? path : resolve(scope.cwd, path);
  let real: string;
  try {
    real = realpathSync(requested);
  } catch {
    throw new ImageError(`${path} does not exist`);
  }
  const roots = scope.roots.flatMap((root) => {
    try {
      return [realpathSync(root)];
    } catch {
      return [];
    }
  });
  if (!roots.some((root) => within(real, root))) throw new ImageError(`${path} is outside the thread's working directory and its attachments`);
  const data = readLimited(real, MAX_SOURCE_BYTES);
  return { ...(await forModel(data)), path: real };
}

export function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** A regular file of at most `max` bytes. */
export function readLimited(path: string, max: number): Uint8Array {
  const fd = openSync(path, "r");
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
