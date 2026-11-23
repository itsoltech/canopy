import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { jsonObject, jsonString, readJson, type JsonObject, type JsonValue } from "../json.ts";

const tokenUrl = "https://oauth2.googleapis.com/token";
const scope = "https://www.googleapis.com/auth/playintegrity";
const jwtGrant = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const refreshMarginMs = 60_000;

export interface ServiceAccount {
  email: string;
  key: KeyObject;
}

type ProviderFetch = (url: string, init: BunFetchRequestInit) => Promise<Response>;

export function readServiceAccount(path: string | undefined): ServiceAccount {
  try {
    if (!path) throw new Error();

    // SAFETY: JSON.parse can only produce JSON values, whose expected fields are checked below.
    const json = JSON.parse(readFileSync(path, "utf8")) as JsonValue;

    if (!jsonObject(json) || json["type"] !== "service_account") throw new Error();

    const email = json["client_email"];
    const privateKey = json["private_key"];

    if (!jsonString(email) || !/^[^\s@]+@[^\s@]+$/.test(email) || !jsonString(privateKey)) throw new Error();

    const key = createPrivateKey(privateKey);

    if (key.asymmetricKeyType !== "rsa") throw new Error();

    return { email, key };
  } catch {
    throw new Error(
      "CANOPY_PUSH_ANDROID_SERVICE_ACCOUNT_FILE must point to a readable Google service-account JSON key.",
    );
  }
}

export async function postToGoogle(
  fetcher: ProviderFetch,
  url: string,
  init: RequestInit,
): Promise<JsonObject | undefined> {
  const signal = AbortSignal.timeout(4_000);

  try {
    const response = await fetcher(url, {
      ...init,
      method: "POST",
      redirect: "error",
      tls: { rejectUnauthorized: true },
      proxy: false,
      verbose: false,
      signal,
    });

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);

      return;
    }

    const result = await readJson(response, 16 * 1024, signal);

    return "value" in result && jsonObject(result.value) ? result.value : undefined;
  } catch {
    return;
  }
}

function serviceAccountAssertion(account: ServiceAccount, now: number) {
  const issuedAt = Math.floor(now / 1_000);

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");

  const claims = Buffer.from(
    JSON.stringify({ iss: account.email, scope, aud: tokenUrl, iat: issuedAt, exp: issuedAt + 3_600 }),
  ).toString("base64url");

  const signed = `${header}.${claims}`;

  const signature = sign("RSA-SHA256", Buffer.from(signed), account.key).toString("base64url");

  return `${signed}.${signature}`;
}

interface AccessToken {
  value: string;
  expiresAt: number;
}

function validExpiry(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 3_600;
}

export class GoogleAccessToken {
  #token?: AccessToken;
  #pending: Promise<AccessToken | undefined> | undefined;

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetcher: ProviderFetch,
    private readonly now: () => number,
  ) {}

  async #request() {
    const now = this.now();
    const assertion = serviceAccountAssertion(this.account, now);
    const body = new URLSearchParams({ grant_type: jwtGrant, assertion });

    const response = await postToGoogle(this.fetcher, tokenUrl, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    const value = response?.["access_token"];
    const expiresIn = response?.["expires_in"];

    if (
      response?.["token_type"] !== "Bearer" ||
      !jsonString(value) ||
      !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(value) ||
      !validExpiry(expiresIn)
    )
      return;

    const token = { value, expiresAt: now + expiresIn * 1_000 };

    this.#token = token;

    return token;
  }

  async get() {
    if (this.#token && this.#token.expiresAt - this.now() > refreshMarginMs) return this.#token.value;

    this.#pending ??= this.#request().finally(() => {
      this.#pending = undefined;
    });

    return (await this.#pending)?.value;
  }
}
