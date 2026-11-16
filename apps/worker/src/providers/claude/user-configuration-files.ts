import { isUtf8 } from "node:buffer";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** Selected source files may be symlinks; only the opened regular file is read, with a fixed byte ceiling. */
export function readClaudeConfigurationFile(path: string, limit = 1024 * 1024): string | undefined {
  let descriptor: number;

  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("Cannot read the selected Claude configuration file.");
  }

  try {
    const stat = fstatSync(descriptor);

    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid file.");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;

    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);

      if (!read) break;
      length += read;
    }

    const bytes = buffer.subarray(0, length);

    if (length > stat.size || !isUtf8(bytes)) throw new Error("Invalid file.");

    return bytes.toString("utf8");
  } catch {
    throw new Error("The selected Claude configuration must be a bounded, regular UTF-8 file.");
  } finally {
    closeSync(descriptor);
  }
}
