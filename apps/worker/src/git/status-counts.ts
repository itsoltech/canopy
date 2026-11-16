import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ThreadGitStatus } from "@canopy/contracts";

export const STATUS_FILE_LIMIT = 2000;
const FILE_BYTES = 1024 * 1024;
const TOTAL_BYTES = 8 * FILE_BYTES;

type Counts = Pick<ThreadGitStatus, "additions" | "deletions" | "binaryFiles" | "linesComplete">;

/** NUL-delimited records preserve tabs/newlines and rename pairs without git's path quoting. */
export function diffNames(output: string): Map<string, string> {
  const fields = output.split("\0");
  const files = new Map<string, string>();

  for (let i = 0; i < fields.length - 1;) {
    const kind = fields[i++]?.[0] ?? "M";
    const first = fields[i++] ?? "";
    const name = kind === "R" || kind === "C" ? (fields[i++] ?? "") : first;
    files.set(name, kind === "C" ? "A" : kind);
  }

  return files;
}

export function diffLines(output: string, counts: Counts): void {
  const fields = output.split("\0");

  for (let i = 0; i < fields.length - 1; i++) {
    const record = fields[i] ?? "";
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    const added = record.slice(0, first);
    const deleted = record.slice(first + 1, second);

    if (added === "-" || deleted === "-") counts.binaryFiles++;
    else {
      counts.additions += Number(added);
      counts.deletions += Number(deleted);
    }

    if (record.slice(second + 1) === "") i += 2;
  }
}

/** Never follow an untracked symlink or read a device, large file, or unlimited source tree. */
export async function newFileLines(root: string, names: readonly string[], counts: Counts): Promise<void> {
  let budget = TOTAL_BYTES;

  for (const name of names) {
    if (budget <= 0) {
      counts.linesComplete = false;
      break;
    }

    try {
      const path = resolve(root, name);
      const parent = relative(root, await realpath(dirname(path)));

      if (isAbsolute(parent) || parent === ".." || parent.startsWith("../") || parent.startsWith("..\\")) {
        counts.linesComplete = false;
        continue;
      }

      const stat = await lstat(path);
      let bytes: Buffer;

      if (stat.isSymbolicLink()) bytes = Buffer.from(await readlink(path));
      else {
        if (!stat.isFile() || stat.size > FILE_BYTES || stat.size > budget) {
          counts.linesComplete = false;
          continue;
        }

        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

        try {
          const current = await file.stat();

          if (!current.isFile() || current.size > FILE_BYTES || current.size > budget) {
            counts.linesComplete = false;
            continue;
          }

          const buffer = Buffer.alloc(Math.min(FILE_BYTES, budget, current.size) + 1);
          const result = await file.read(buffer, 0, buffer.length, 0);
          bytes = buffer.subarray(0, result.bytesRead);

          if (bytes.length > FILE_BYTES || bytes.length > budget || bytes.length !== current.size) {
            counts.linesComplete = false;
            continue;
          }
        } finally {
          await file.close();
        }
      }

      budget -= bytes.length;

      if (bytes.subarray(0, 8000).includes(0)) counts.binaryFiles++;
      else {
        for (const byte of bytes) if (byte === 10) counts.additions++;

        if (bytes.length && bytes[bytes.length - 1] !== 10) counts.additions++;
      }
    } catch {
      counts.linesComplete = false;
    }
  }
}
