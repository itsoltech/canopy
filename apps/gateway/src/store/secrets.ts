import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readEnv } from "@canopy/domain/env";

/**
 * Envelope for secrets at rest (docs/worker-config.md, "Sekrety"): AES-256-GCM with a master key
 * from the environment (CANOPY_SECRETS_KEY, 32 bytes base64). Layout: iv (12) | tag (16) | ciphertext.
 * key_id is stored with every row so the master key can be rotated.
 */
export const SECRETS_KEY_ID = "env-v1";

export function loadSecretsKey(env: Readonly<Record<string, string | undefined>>): Buffer {
  const raw = readEnv("CANOPY_SECRETS_KEY", env);
  if (!raw) throw new Error("CANOPY_SECRETS_KEY is not set (32 random bytes, base64): openssl rand -base64 32");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("CANOPY_SECRETS_KEY must decode to exactly 32 bytes");
  return key;
}

export function encryptSecret(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

export function decryptSecret(key: Buffer, envelope: Uint8Array): string {
  const buffer = Buffer.from(envelope);
  const decipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8");
}
