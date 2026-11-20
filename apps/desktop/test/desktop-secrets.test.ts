import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { tempDir } from "@canopy/testing";
import { readDesktopSecrets } from "../src/desktop-secrets.ts";

test("upgrading the vault retains all three existing credentials and persists a separate runtime password", async () => {
  const directory = tempDir("canopy-vault-upgrade-");
  const path = join(directory, "secrets.enc");

  const original = {
    databasePassword: "fixture-db",
    secretsKey: "fixture-key",
    serviceToken: "fixture-service",
    metadata: { version: 2 },
  };

  const storage = {
    encryptStringAsync: async (value: string) => Buffer.from(value, "utf8"),
    decryptStringAsync: async (data: Buffer) => ({ result: data.toString("utf8"), shouldReEncrypt: false }),
  };

  const sealed = await storage.encryptStringAsync(JSON.stringify(original));
  writeFileSync(path, sealed, { mode: 0o600 });
  await expect(
    readDesktopSecrets(directory, {
      ...storage,
      encryptStringAsync: () => Promise.reject(new Error("Test keychain unavailable")),
    }),
  ).rejects.toThrow("Test keychain unavailable");
  expect(readFileSync(path).equals(sealed)).toBe(true);
  const upgraded = await readDesktopSecrets(directory, storage);
  expect(
    upgraded.databasePassword === original.databasePassword &&
      upgraded.secretsKey === original.secretsKey &&
      upgraded.serviceToken === original.serviceToken,
  ).toBe(true);
  expect(
    upgraded.runtimeDatabasePassword !== original.databasePassword && upgraded.runtimeDatabasePassword.length === 64,
  ).toBe(true);
  const first = readFileSync(path);
  expect(JSON.parse((await storage.decryptStringAsync(first)).result).metadata).toEqual(original.metadata);
  expect(
    (await readDesktopSecrets(directory, storage)).runtimeDatabasePassword === upgraded.runtimeDatabasePassword,
  ).toBe(true);
  expect(first.equals(readFileSync(path))).toBe(true);
});
