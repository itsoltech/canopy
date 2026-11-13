import { closeSync, fstatSync, readSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { IMAGE_REPLY_LIMITS } from "@canopy/domain/image-replies";
import { CommandError } from "../runtime/host-types.ts";
import { descriptorPath } from "./descriptor-path.ts";
import type { ImageRoot } from "./export-root.ts";

export const imageRefusal = (message: string) => new CommandError("IMAGE_EXPORT_REFUSED", message, true);

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);

  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function openImageSource(path: string, roots: readonly ImageRoot[], maxBytes: number) {
  // Reject traversal before normalization, URLs, UNC/device paths and NTFS alternate streams.
  if (
    !path ||
    path.includes("\0") ||
    path.split(/[\\/]/).includes("..") ||
    /^([a-z]+:|[/\\]{2})/i.test(path.replace(/^[a-z]:[/\\]/i, ""))
  )
    throw imageRefusal("Use an image path inside this thread's directory.");
  const full = isAbsolute(path) ? path : resolve(roots[0]?.path ?? "", path);
  const root = roots.find((r) => inside(r.path, full) || inside(r.canonical, full));

  if (!root || (process.platform === "win32" && full.slice(2).includes(":")))
    throw imageRefusal("This image is outside this thread's directory. Choose a file inside it.");
  const base = inside(root.path, full) ? root.path : root.canonical;
  const fd = root.open(relative(base, full).split(sep));

  try {
    const stat = fstatSync(fd);
    const actual = descriptorPath(fd);

    if (!inside(root.canonical, actual) || !stat.isFile() || stat.nlink !== 1)
      throw imageRefusal("The image path changed. Choose a regular file inside this thread's directory.");
    root.verify();

    if (stat.size <= 0 || stat.size > maxBytes)
      throw imageRefusal("This image exceeds the remaining image limit. Choose a smaller image.");

    return { fd, stat, root, name: full.slice(dirname(full).length + 1) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Read once into a bounded immutable snapshot. A changed file never publishes a partial copy. */
export async function snapshotImage(source: ReturnType<typeof openImageSource>, valid: () => boolean) {
  source.root.verify();
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
  source.root.verify();
  const after = fstatSync(source.fd);

  if (after.size !== source.stat.size || after.mtimeMs !== source.stat.mtimeMs || after.ctimeMs !== source.stat.ctimeMs)
    throw imageRefusal("The image changed. Try again.");

  return { data, sha256: hash.digest("hex") };
}
