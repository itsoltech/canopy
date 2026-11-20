import { safeStorage } from "electron";
import { readDesktopSecrets } from "./desktop-secrets.ts";
import type { Secrets } from "./runtime/runtime.ts";

export async function loadSecrets(directory: string): Promise<Secrets> {
  if (
    !(await safeStorage.isAsyncEncryptionAvailable()) ||
    (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
  ) {
    throw new Error(
      "Canopy needs an unlocked OS keychain (Secret Service/KWallet on Linux). Enable it and reopen Canopy.",
    );
  }

  return readDesktopSecrets(directory, safeStorage);
}
