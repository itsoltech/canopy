import { create } from "@bufbuild/protobuf";
import { timestampFromDate, timestampNow } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { redactCredentials } from "@canopy/domain";
import { Option, Schema } from "effect";

/** Upper bounds for an untrusted management response (docs/proxies.md, "Konta upstream"). */
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ACCOUNTS = 200;
const TIMEOUT_MS = 10_000;

const Text = Schema.optional(Schema.NullOr(Schema.String));
const Flag = Schema.optional(Schema.NullOr(Schema.Boolean));
const Count = Schema.optional(Schema.NullOr(Schema.Number));

/** The fields Canopy reads from CLIProxyAPI `GET /v0/management/auth-files` (v8.0.x); the rest is ignored. */
const AuthFile = Schema.Struct({
  id: Text,
  auth_index: Text,
  name: Text,
  provider: Text,
  type: Text,
  label: Text,
  email: Text,
  account: Text,
  status: Text,
  status_message: Text,
  disabled: Flag,
  unavailable: Flag,
  requires_sign_in: Flag,
  quota_blocked: Flag,
  next_retry_after: Text,
  success: Count,
  failed: Count,
  quota: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        observed_at: Text,
        signals: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
      }),
    ),
  ),
  refresh_error: Schema.optional(Schema.NullOr(Schema.Struct({ message: Text }))),
});

type AuthFile = typeof AuthFile.Type;

const Listing = Schema.Struct({ files: Schema.Array(Schema.Unknown) });
const decodeFile = Schema.decodeUnknownOption(AuthFile);
const decodeListing = Schema.decodeUnknownOption(Listing);

export type Redact = (text: string) => string;

/**
 * Removes the exact secrets this read knows (management key, proxy secret) and their usual encodings. A proxy that
 * echoes a key in an account field must not hand it to clients: patterns alone cannot recognise an opaque key.
 */
export function secretRedactor(secrets: readonly string[]): Redact {
  const forms = [
    ...new Set(
      secrets
        .filter((secret) => secret.length >= 4)
        .flatMap((secret) => {
          const base64 = Buffer.from(secret, "utf8").toString("base64");

          return [
            secret,
            encodeURIComponent(secret),
            base64,
            base64.replace(/=+$/, ""),
            Buffer.from(secret, "utf8").toString("base64url"),
          ];
        }),
    ),
  ].sort((a, b) => b.length - a.length);

  return (text) => forms.reduce((value, form) => value.split(form).join("[redacted]"), text);
}

/** Plain text only: known secrets, control characters, markup and credentials removed, then length capped. */
export function plainText(value: string | null | undefined, max: number, redact: Redact = (text) => text): string {
  const text = redact(
    redactCredentials(
      redact(value ?? "")
        // oxlint-disable-next-line no-control-regex -- strips control characters from untrusted text
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
        .replace(/<[^>]{0,200}>/g, " ")
        .replace(/[<>]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  );

  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const time = (value: string | number | null | undefined) => {
  const date = value === null || value === undefined || value === "" ? undefined : new Date(value);

  return date && Number.isFinite(date.getTime()) && date.getTime() > 0 && date.getFullYear() < 9999 ? date : undefined;
};

const percent = (value: number) => (Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) : undefined);

const WINDOWS = new Map([
  [300, "five_hour"],
  [10080, "seven_day"],
]);

const windowKey = (minutes: number) => WINDOWS.get(minutes) ?? "usage";

/** Codex `x-codex-{primary,secondary}-*` and Claude `anthropic-ratelimit-unified-{5h,7d}-*` headers the proxy saw. */
function windows(file: AuthFile, observed: Date | undefined) {
  const signals = new Map(Object.entries(file.quota?.signals ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const result: { key: string; usedPercent?: number; resetsAt?: Date; reached: boolean }[] = [];

  for (const slot of ["primary", "secondary"]) {
    const used = signals.get(`x-codex-${slot}-used-percent`);

    if (used === undefined) continue;
    const after = Number(signals.get(`x-codex-${slot}-reset-after-seconds`));
    const usedPercent = percent(Number(used));

    const resetsAt =
      time(Number(signals.get(`x-codex-${slot}-reset-at`)) * 1000) ??
      (observed && after > 0 ? new Date(observed.getTime() + after * 1000) : undefined);

    result.push({
      key: windowKey(Number(signals.get(`x-codex-${slot}-window-minutes`))),
      ...(usedPercent !== undefined && { usedPercent }),
      ...(resetsAt && { resetsAt }),
      reached: (usedPercent ?? 0) >= 100,
    });
  }

  for (const [span, key] of [
    ["5h", "five_hour"],
    ["7d", "seven_day"],
  ] as const) {
    const used = signals.get(`anthropic-ratelimit-unified-${span}-utilization`);

    if (used === undefined) continue;
    const usedPercent = percent(Number(used) * 100);
    const resetsAt = time(Number(signals.get(`anthropic-ratelimit-unified-${span}-reset`)) * 1000);

    result.push({
      key,
      ...(usedPercent !== undefined && { usedPercent }),
      ...(resetsAt && { resetsAt }),
      reached: signals.get(`anthropic-ratelimit-unified-${span}-status`) === "rejected" || (usedPercent ?? 0) >= 100,
    });
  }

  return result.slice(0, 4).map((w) => ({ ...w, resetsAt: w.resetsAt && timestampFromDate(w.resetsAt) }));
}

function status(file: AuthFile, retry: Date | undefined, now: number) {
  if (file.disabled || file.status === "disabled") return "disabled";

  if (file.requires_sign_in) return "sign_in";

  if (file.quota_blocked || (file.unavailable && retry && retry.getTime() > now)) return "cooling_down";

  return file.status === "error" || file.unavailable ? "error" : "active";
}

const count = (value: number | null | undefined) => BigInt(Number.isSafeInteger(value) && value! > 0 ? value! : 0);

/** One auth file as a typed, sanitized account; the provider name keeps only a short lower-case token. */
export function proxyAccount(file: AuthFile, now = Date.now(), redact: Redact = (text) => text): ui.ProxyAccount {
  const retry = time(file.next_retry_after);
  const observed = time(file.quota?.observed_at);
  const raw = (file.provider || file.type || "").toLowerCase();
  const provider = redact(raw) === raw ? raw : "";

  return create(ui.ProxyAccountSchema, {
    id: plainText(file.auth_index || file.id || file.name, 120, redact),
    provider: /^[a-z0-9_-]{1,32}$/.test(provider) ? provider : "other",
    label: plainText(file.email || file.account || file.label || file.name, 120, redact),
    status: status(file, retry, now),
    detail: plainText(file.refresh_error?.message || file.status_message, 160, redact),
    retryAt: retry && retry.getTime() > now ? timestampFromDate(retry) : undefined,
    windows: windows(file, observed),
    successCount: count(file.success),
    failureCount: count(file.failed),
  });
}

/** At most `max` bytes of a body; the rest is cancelled unread. `overflow` marks a body that was longer. */
async function readBounded(response: Response, max: number): Promise<{ bytes: Buffer; overflow: boolean }> {
  const reader = response.body?.getReader();

  if (!reader) return { bytes: Buffer.alloc(0), overflow: false };
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) return { bytes: Buffer.concat(chunks), overflow: false };

    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      await reader.cancel().catch(() => {});

      return { bytes: Buffer.concat(chunks), overflow: true };
    }

    size += value.byteLength;
    chunks.push(value);
  }
}

/** A larger body than `MAX_BYTES` is rejected rather than parsed partially. */
async function boundedListing(response: Response) {
  const body = await readBounded(response, MAX_BYTES);

  if (body.overflow) return Option.none();

  try {
    return decodeListing(JSON.parse(body.bytes.toString("utf8")));
  } catch {
    return Option.none();
  }
}

const result = (proxyId: string, state: string, accounts: ui.ProxyAccount[] = [], total = accounts.length) =>
  create(ui.ProxyAccountsSchema, { proxyId, state, accounts, total, checkedAt: timestampNow() });

/**
 * Lists a CLIProxyAPI proxy's upstream accounts with its management key. The key goes only in this request's
 * header; redirects are refused so it cannot reach another host. Response bodies never leave as text.
 */
export async function readProxyAccounts(
  proxyId: string,
  root: string,
  key: string,
  secrets: readonly string[] = [],
): Promise<ui.ProxyAccounts> {
  if (!key) return result(proxyId, "no_key");

  try {
    const response = await fetch(`${root}/v0/management/auth-files`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });

    if (!response.ok) {
      // Only a short prefix of an error body is read; the rest is never buffered.
      const forbidden = response.status === 403 ? (await readBounded(response, 512)).bytes.toString("utf8") : "";
      await response.body?.cancel().catch(() => {});

      if (response.status === 401) return result(proxyId, "unauthorized");

      if (response.status === 403)
        return result(proxyId, /remote management disabled/i.test(forbidden) ? "remote_disabled" : "unauthorized");

      return result(proxyId, "unavailable");
    }

    const listing = await boundedListing(response);

    if (Option.isNone(listing)) return result(proxyId, "invalid_response");
    const files = listing.value.files.flatMap((value) => Option.toArray(decodeFile(value)));
    const now = Date.now();
    const redact = secretRedactor([key, ...secrets]);

    return result(
      proxyId,
      "ok",
      files.slice(0, MAX_ACCOUNTS).map((file) => proxyAccount(file, now, redact)),
      listing.value.files.length,
    );
  } catch {
    return result(proxyId, "unreachable");
  }
}
