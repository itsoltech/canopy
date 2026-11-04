import { safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Secrets } from "./runtime/runtime.ts";

function isSecrets(value: unknown): value is Secrets {
  return (
    !!value &&
    typeof value === "object" &&
    "databasePassword" in value &&
    typeof value.databasePassword === "string" &&
    "secretsKey" in value &&
    typeof value.secretsKey === "string" &&
    "serviceToken" in value &&
    typeof value.serviceToken === "string"
  );
}

export async function loadSecrets(directory: string): Promise<Secrets> {
  if (
    !(await safeStorage.isAsyncEncryptionAvailable()) ||
    (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
  ) {
    throw new Error(
      "Canopy needs an unlocked OS keychain (Secret Service/KWallet on Linux). Enable it and reopen Canopy.",
    );
  }

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "secrets.enc");

  if (existsSync(path)) {
    const decrypted = await safeStorage.decryptStringAsync(readFileSync(path));
    const secrets: unknown = JSON.parse(decrypted.result);

    if (!isSecrets(secrets)) throw new Error("Invalid desktop secrets file; restore it from your backup");

    if (decrypted.shouldReEncrypt) {
      writeFileSync(`${path}.new`, await safeStorage.encryptStringAsync(decrypted.result), { mode: 0o600 });
      renameSync(`${path}.new`, path);
    }

    return secrets;
  }

  const secrets: Secrets = {
    databasePassword: randomBytes(32).toString("hex"),
    secretsKey: randomBytes(32).toString("base64"),
    serviceToken: randomBytes(32).toString("hex"),
  };

  writeFileSync(`${path}.new`, await safeStorage.encryptStringAsync(JSON.stringify(secrets)), { mode: 0o600 });
  renameSync(`${path}.new`, path);

  return secrets;
}
