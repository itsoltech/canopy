import { safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { configuration } from "./runtime/config.ts";
import { migrateDesktopClient } from "./client-migration.ts";
import {
  credentialMessage,
  pairDesktop,
  readDesktopCredential,
  remoteWorkerDirectory,
  type DesktopClientCredential,
  type RemoteConfiguration,
} from "./remote-client.ts";

async function keychain() {
  if (
    !(await safeStorage.isAsyncEncryptionAvailable()) ||
    (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
  )
    throw new Error("Unlock your OS keychain and reopen Canopy to pair this app");
}

/** Electron main only. No plaintext credential is persisted or returned through renderer IPC. */
export async function remoteClient(
  directory: string,
  config: RemoteConfiguration,
): Promise<DesktopClientCredential | undefined> {
  const folder = remoteWorkerDirectory(directory, config);
  const file = join(folder, "desktop-client.enc");

  if (config.pairingInvitation?.trim() || !existsSync(file)) {
    await keychain();

    const client = config.pairingInvitation?.trim()
      ? await pairDesktop(config.pairingInvitation)
      : await migrateDesktopClient(folder);

    if (!client) return undefined;

    const sealed = await safeStorage.encryptStringAsync(
      toJsonString(ui.ExchangeMobilePairingResponseSchema, credentialMessage(client)),
    );

    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.new`, sealed, { mode: 0o600 });
    renameSync(`${file}.new`, file);

    return client;
  }

  await keychain();
  const decrypted = await safeStorage.decryptStringAsync(readFileSync(file));
  const client = readDesktopCredential(decrypted.result);

  if (decrypted.shouldReEncrypt) {
    writeFileSync(`${file}.new`, await safeStorage.encryptStringAsync(decrypted.result), { mode: 0o600 });
    renameSync(`${file}.new`, file);
  }

  return client;
}

export async function savedRemoteClient(directory: string) {
  const file = join(directory, "desktop.json");

  if (!existsSync(file)) return undefined;
  const config = configuration(JSON.parse(readFileSync(file, "utf8")));

  return config.mode === "remote" ? remoteClient(directory, config) : undefined;
}
