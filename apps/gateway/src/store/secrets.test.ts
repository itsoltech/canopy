import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, loadSecretsKey } from "./secrets.ts";

describe("secrets", () => {
  const key = randomBytes(32);

  test("round trip; every encryption uses a fresh IV", () => {
    const a = encryptSecret(key, "sk-proxy");
    const b = encryptSecret(key, "sk-proxy");
    expect(decryptSecret(key, a)).toBe("sk-proxy");
    expect(a.equals(b)).toBe(false);
  });

  test("tampering or a wrong key fails instead of returning garbage", () => {
    const envelope = encryptSecret(key, "sk-proxy");
    envelope[envelope.length - 1]! ^= 1;
    expect(() => decryptSecret(key, envelope)).toThrow();
    expect(() => decryptSecret(randomBytes(32), encryptSecret(key, "x"))).toThrow();
  });

  test("master key from the environment must be 32 bytes", () => {
    expect(() => loadSecretsKey({})).toThrow("OA_SECRETS_KEY is not set");
    expect(() => loadSecretsKey({ OA_SECRETS_KEY: Buffer.from("short").toString("base64") })).toThrow("32 bytes");
    expect(loadSecretsKey({ OA_SECRETS_KEY: key.toString("base64") }).equals(key)).toBe(true);
  });
});
