/** Time-based one-time codes (RFC 6238) for project logins. Uses Web Crypto, so it runs in Bun and browsers. */

export interface OneTimeCodeSetup {
  key: Uint8Array<ArrayBuffer>;
  algorithm: "SHA-1" | "SHA-256" | "SHA-512";
  digits: number;
  period: number;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const ALGORITHMS = new Map<string, OneTimeCodeSetup["algorithm"]>([
  ["SHA1", "SHA-1"],
  ["SHA256", "SHA-256"],
  ["SHA512", "SHA-512"],
]);

function decodeBase32(input: string): Uint8Array<ArrayBuffer> | undefined {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();

  if (!clean || clean.length > 1024) return;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of clean) {
    const value = BASE32.indexOf(char);

    if (value < 0) return;
    buffer = (buffer << 5) | value;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return bytes.length >= 10 ? new Uint8Array(bytes) : undefined;
}

function integer(value: string | null, fallback: number, allowed: (value: number) => boolean): number | undefined {
  if (value === null) return fallback;
  const parsed = Number(value);

  return Number.isInteger(parsed) && allowed(parsed) ? parsed : undefined;
}

/** Accepts a base32 setup key or an `otpauth://totp/…` URI. */
export function parseOneTimeCodeSetup(input: string): OneTimeCodeSetup | undefined {
  const trimmed = input.trim();

  if (!/^otpauth:/i.test(trimmed)) {
    const key = decodeBase32(trimmed);

    return key && { key, algorithm: "SHA-1", digits: 6, period: 30 };
  }

  const uri = URL.parse(trimmed);

  if (!uri || uri.host.toLowerCase() !== "totp") return;
  const key = decodeBase32(uri.searchParams.get("secret") ?? "");
  const algorithm = ALGORITHMS.get((uri.searchParams.get("algorithm") ?? "SHA1").toUpperCase());
  const digits = integer(uri.searchParams.get("digits"), 6, (value) => value >= 6 && value <= 8);
  const period = integer(uri.searchParams.get("period"), 30, (value) => value >= 10 && value <= 300);

  return key && algorithm && digits && period ? { key, algorithm, digits, period } : undefined;
}

/** The code for `at`, and when it stops being valid. */
export async function oneTimeCode(
  setup: OneTimeCodeSetup,
  at = Date.now(),
): Promise<{ code: string; expiresAt: number }> {
  const step = Math.floor(at / 1000 / setup.period);
  const counter = new ArrayBuffer(8);
  const view = new DataView(counter);
  view.setUint32(0, Math.floor(step / 2 ** 32));
  view.setUint32(4, step >>> 0);

  const key = await crypto.subtle.importKey("raw", setup.key, { name: "HMAC", hash: setup.algorithm }, false, ["sign"]);

  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  const window = new DataView(mac.buffer, offset, 4).getUint32(0) & 0x7fffffff;
  const code = String(window % 10 ** setup.digits).padStart(setup.digits, "0");

  return { code, expiresAt: (step + 1) * setup.period * 1000 };
}
