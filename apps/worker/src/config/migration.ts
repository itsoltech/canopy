import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Result } from "effect";
import { parseLocalConfig, type LocalConfig } from "./local.ts";

/** Write beside the destination, fsync, then rename. Both config and original backup contain credentials. */
export function saveMigratedConfig(path: string, expected: LocalConfig, migrated: LocalConfig) {
  const original = readFileSync(path, "utf8");
  const parsed = parseLocalConfig(original);

  if (Result.isFailure(parsed) || !isDeepStrictEqual(parsed.success, expected))
    throw new Error("Worker config changed on disk; migration postponed until restart");

  // Never overwrite the first pre-migration config, including on retries after a restart.
  if (!expected.gateway_fallback) {
    saveBackup(path, original);
    syncDirectory(path);
  }

  const temporary = `${path}.${crypto.randomUUID()}.migrating`;

  try {
    writeExclusive(temporary, `${JSON.stringify(migrated, null, 2)}\n`);
    renameSync(temporary, path);

    syncDirectory(path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Already renamed or not created. */
    }
  }
}

function saveBackup(path: string, original: string) {
  const temporary = `${path}.${crypto.randomUUID()}.backup`;
  const backup = `${path}.bak`;

  try {
    writeExclusive(temporary, original);

    try {
      // Atomic and exclusive: an interrupted write cannot leave a partial backup blocking all retries.
      linkSync(temporary, backup);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const file = lstatSync(backup);

      if (
        !file.isFile() ||
        (process.platform !== "win32" && (file.mode & 0o077) !== 0) ||
        readFileSync(backup, "utf8") !== original
      )
        throw new Error("Existing worker backup does not match the private original config");
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Not created if disk access failed. */
    }
  }
}

function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const directory = openSync(dirname(path), "r");

  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function writeExclusive(path: string, contents: string) {
  const file = openSync(path, "wx", 0o600);

  try {
    writeFileSync(file, contents, "utf8");
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}
