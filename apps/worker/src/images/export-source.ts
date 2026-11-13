import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { IMAGE_REPLY_LIMITS } from "@canopy/domain/image-replies";
import { CommandError } from "../runtime/host-types.ts";
import { descriptorPath } from "./descriptor-path.ts";

export const imageRefusal = (message: string) => new CommandError("IMAGE_EXPORT_REFUSED", message, true);

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);

  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Refuse links (including Windows junctions) before opening; descriptor scope is checked again before reading. */
function checkParents(root: string, path: string): void {
  let current = root;
  const parts = relative(root, path).split(sep);

  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const stat = lstatSync(current);

    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
      throw imageRefusal("This image path contains a link. Use a regular file inside this thread's directory.");
  }
}

export function openImageSource(path: string, roots: readonly string[], maxBytes: number) {
  // Reject traversal before normalization, URLs, UNC/device paths and NTFS alternate streams.
  if (
    !path ||
    path.includes("\0") ||
    path.split(/[\\/]/).includes("..") ||
    /^([a-z]+:|[/\\]{2})/i.test(path.replace(/^[a-z]:[/\\]/i, ""))
  )
    throw imageRefusal("Use an image path inside this thread's directory.");
  const full = isAbsolute(path) ? path : resolve(roots[0] ?? "", path);

  const root = roots
    .flatMap((r) => {
      try {
        return [realpathSync(r)];
      } catch {
        return [];
      }
    })
    .find((r) => inside(r, full));

  if (!root || (process.platform === "win32" && full.slice(2).includes(":")))
    throw imageRefusal("This image is outside this thread's directory. Choose a file inside it.");
  checkParents(root, full);
  const before = lstatSync(full);

  if (!before.isFile() || before.nlink !== 1) throw imageRefusal("Choose a regular image file without links.");
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));

  try {
    const stat = fstatSync(fd);
    const actual = descriptorPath(fd);

    if (
      !inside(root, actual) ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      !stat.isFile() ||
      stat.nlink !== 1
    )
      throw imageRefusal("The image path changed. Choose a regular file inside this thread's directory.");
    checkParents(root, actual);

    if (stat.size <= 0 || stat.size > maxBytes)
      throw imageRefusal("This image exceeds the remaining image limit. Choose a smaller image.");

    return { fd, stat, name: full.slice(dirname(full).length + 1) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Read once into a bounded immutable snapshot. A changed file never publishes a partial copy. */
export async function snapshotImage(source: ReturnType<typeof openImageSource>, valid: () => boolean) {
  const data = Buffer.alloc(source.stat.size);
  const hash = createHash("sha256");

  for (let offset = 0; offset < data.length;) {
    if (!valid()) throw imageRefusal("The image transfer expired. Try again.");

    const count = readSync(
      source.fd,
      data,
      offset,
      Math.min(IMAGE_REPLY_LIMITS.chunkBytes, data.length - offset),
      offset,
    );

    if (!count) throw imageRefusal("The image changed. Try again.");
    hash.update(data.subarray(offset, offset + count));
    offset += count;
    await Bun.sleep(0);
  }

  if (!valid()) throw imageRefusal("The image transfer expired. Try again.");
  const after = fstatSync(source.fd);

  if (after.size !== source.stat.size || after.mtimeMs !== source.stat.mtimeMs || after.ctimeMs !== source.stat.ctimeMs)
    throw imageRefusal("The image changed. Try again.");

  return { data, sha256: hash.digest("hex") };
}
