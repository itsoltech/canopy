import { safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { pinnedOrigins } from "@canopy/transport";
import { configuration } from "./runtime/config.ts";
import { writePrivateFile } from "./runtime/private-file.ts";
import {
  credentialMessage,
  desktopGatewayRoutes,
  pairDesktop,
  readDesktopCredential,
  readDesktopInvitation,
  remoteWorkerDirectory,
  type DesktopClientCredential,
  type RemoteConfiguration,
} from "./remote-client.ts";

export async function keychain() {
  if (
    !(await safeStorage.isAsyncEncryptionAvailable()) ||
    (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
  )
    throw new Error("Unlock your OS keychain and reopen Canopy to pair this app");
}

export async function saveRemoteClient(
  directory: string,
  config: RemoteConfiguration,
  client: DesktopClientCredential,
) {
  await keychain();
  const folder = remoteWorkerDirectory(directory, config);

  const sealed = await safeStorage.encryptStringAsync(
    toJsonString(ui.ExchangeMobilePairingResponseSchema, credentialMessage(client)),
  );

  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writePrivateFile(join(folder, "desktop-client.enc"), sealed);
}

/** Electron main only. No plaintext credential is persisted or returned through renderer IPC. */
async function remoteClient(
  directory: string,
  config: RemoteConfiguration,
  refreshEncryption = true,
): Promise<DesktopClientCredential | undefined> {
  const folder = remoteWorkerDirectory(directory, config);
  const file = join(folder, "desktop-client.enc");

  if (!existsSync(file)) return undefined;
  await keychain();
  const decrypted = await safeStorage.decryptStringAsync(readFileSync(file));
  const client = readDesktopCredential(decrypted.result);

  if (refreshEncryption && decrypted.shouldReEncrypt) {
    writeFileSync(`${file}.new`, await safeStorage.encryptStringAsync(decrypted.result), { mode: 0o600 });
    renameSync(`${file}.new`, file);
  }

  return client;
}

async function differentGatewayProfile(
  directory: string,
  config: RemoteConfiguration,
  invitation: ReturnType<typeof readDesktopInvitation>,
) {
  const routes = desktopGatewayRoutes(invitation.routes, config.gatewayUrl);
  const fingerprint = routes.fingerprint.toLowerCase();
  let available: RemoteConfiguration | undefined;

  for (const gatewayUrl of pinnedOrigins(routes.addresses)) {
    const profile = { ...config, workerGatewayUrl: gatewayUrl };
    const credential = await remoteClient(directory, profile, false).catch(() => undefined);

    if (credential?.fingerprint === fingerprint) return profile;
    const folder = remoteWorkerDirectory(directory, profile);

    if (!available && !["desktop-client.enc", "worker.json", "data"].some((entry) => existsSync(join(folder, entry))))
      available = profile;
  }

  if (available) return available;
  throw new Error("These addresses already have Desktop profiles. Enter another HTTPS address for this gateway.");
}

export async function configureRemoteClient(directory: string, config: RemoteConfiguration) {
  const text = config.pairingInvitation?.trim();

  if (!text) return { config, client: await remoteClient(directory, config) };
  await keychain();

  const invitation = readDesktopInvitation(text);
  // A fresh invitation also recovers a vault entry this installation can no longer read.
  const existing = await remoteClient(directory, config, false).catch(() => undefined);
  const switchingGateway = existing && existing.fingerprint !== invitation.routes.fingerprint.toLowerCase();
  const profile = switchingGateway ? await differentGatewayProfile(directory, config, invitation) : config;
  const { address, ...client } = await pairDesktop(text, config.gatewayUrl);
  const selected = switchingGateway && !config.enrollmentToken ? { ...profile, gatewayUrl: address } : profile;

  await saveRemoteClient(directory, selected, client);

  return { config: selected, client };
}

export async function savedRemoteClient(directory: string) {
  const file = join(directory, "desktop.json");

  if (!existsSync(file)) return undefined;
  const config = configuration(JSON.parse(readFileSync(file, "utf8")));

  return config.mode === "remote" ? remoteClient(directory, config) : undefined;
}
