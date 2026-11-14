import { closeSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { descriptorPath } from "./descriptor-path.ts";
import { pinImageRoot } from "./export-root.ts";

/**
 * Release smoke for the native calls show_images makes (bun:ffi): pin this binary's directory, open the binary
 * through it and ask the OS for the descriptor's path. A wrong calling convention fails here, on its own runner.
 */
export function imageExportSelfCheck(): string | undefined {
  const binary = realpathSync(process.execPath);
  const fd = pinImageRoot(dirname(binary)).open([basename(binary)]);

  try {
    const actual = descriptorPath(fd);
    const same = process.platform === "win32" ? actual.toLowerCase() === binary.toLowerCase() : actual === binary;

    return same ? undefined : `image export resolved ${JSON.stringify(actual)}, expected ${JSON.stringify(binary)}`;
  } finally {
    closeSync(fd);
  }
}
