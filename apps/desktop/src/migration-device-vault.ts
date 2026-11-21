import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import { Schema } from "effect";
import { keychain } from "./client-vault.ts";
import { syncDirectory, writePrivateFile } from "./runtime/private-file.ts";
import { desktopDeviceSchema } from "../../gateway/src/migration/cutover-protocol.ts";

const decodeDevice = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String.check(Schema.isUUID()),
      token: Schema.String.check(Schema.isPattern(/^canopy_desktop_[A-Za-z0-9_-]{43}$/)),
    }),
  ),
);

const devicePath = (directory: string, runId: string) => join(directory, `gateway-migration-${runId}.enc`);

/** The cleartext token exists only in Electron main and the private launch pipe. The server receives its hash. */
export async function migrationDevice(directory: string, runId: string, create: boolean) {
  const path = devicePath(directory, runId);
  await keychain();

  if (existsSync(path)) return decodeDevice((await safeStorage.decryptStringAsync(readFileSync(path))).result);

  if (!create) throw new Error("Could not open this migration’s desktop credential. Restore it from backup.");

  const device = { id: randomUUID(), token: `canopy_desktop_${randomBytes(32).toString("base64url")}` };
  writePrivateFile(path, await safeStorage.encryptStringAsync(JSON.stringify(device)));

  return device;
}

export function deviceRegistration(device: { id: string; token: string }): typeof desktopDeviceSchema.Type {
  return Schema.decodeUnknownSync(desktopDeviceSchema)({
    id: device.id,
    tokenHash: createHash("sha256").update(device.token).digest("hex"),
    name:
      hostname()
        .replace(/[\p{Cc}]/gu, "")
        .trim()
        .slice(0, 100) || "Canopy Desktop",
    platform: process.platform,
  });
}

export function removeMigrationDevice(directory: string, runId: string) {
  rmSync(devicePath(directory, runId), { force: true });
  syncDirectory(directory);
}
