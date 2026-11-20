import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Option, Schema } from "effect";
import type { Secrets } from "./runtime/config.ts";
import { writePrivateFile } from "./runtime/private-file.ts";

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.StructWithRest(
      Schema.Struct({
        databasePassword: Schema.String,
        runtimeDatabasePassword: Schema.optionalKey(Schema.String),
        secretsKey: Schema.String,
        serviceToken: Schema.String,
      }),
      [Schema.JsonObject],
    ),
  ),
);

export async function readDesktopSecrets(
  directory: string,
  storage: {
    decryptStringAsync: (data: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>;
    encryptStringAsync: (text: string) => Promise<Buffer>;
  },
): Promise<Secrets> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "secrets.enc");
  const decrypted = existsSync(path) ? await storage.decryptStringAsync(readFileSync(path)) : undefined;

  const stored = decrypted
    ? Option.getOrThrowWith(
        decode(decrypted.result),
        () => new Error("Invalid desktop secrets file; restore it from your backup"),
      )
    : {
        databasePassword: randomBytes(32).toString("hex"),
        runtimeDatabasePassword: undefined,
        secretsKey: randomBytes(32).toString("base64"),
        serviceToken: randomBytes(32).toString("hex"),
      };

  const secrets: Secrets = {
    databasePassword: stored.databasePassword,
    secretsKey: stored.secretsKey,
    serviceToken: stored.serviceToken,
    runtimeDatabasePassword: stored.runtimeDatabasePassword ?? randomBytes(32).toString("hex"),
  };

  if (stored.runtimeDatabasePassword === undefined || decrypted?.shouldReEncrypt)
    writePrivateFile(path, await storage.encryptStringAsync(JSON.stringify({ ...stored, ...secrets })));

  return secrets;
}
