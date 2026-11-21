import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Replace the inode too: an older file restored with loose permissions must not receive new secrets. */
export function writePrivateFile(path: string, data: string | Buffer): void {
  const pending = `${path}.${randomUUID()}.new`;
  const fd = openSync(pending, "wx", 0o600);

  try {
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(pending, path);
    syncDirectory(dirname(path));
  } finally {
    rmSync(pending, { force: true });
  }
}
