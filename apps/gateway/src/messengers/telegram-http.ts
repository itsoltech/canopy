import { Option, Schema } from "effect";
import { MessengerError } from "./messenger-error.ts";
import type { MessengerTransport } from "./provider.ts";

const TelegramResponse = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Json),
  error_code: Schema.optional(Schema.Number),
  description: Schema.optional(Schema.String),
  parameters: Schema.optional(
    Schema.Struct({
      retry_after: Schema.optional(Schema.Number),
      migrate_to_chat_id: Schema.optional(Schema.Number),
    }),
  ),
});

const decodeResponse = Schema.decodeUnknownOption(TelegramResponse);

export type TelegramBody = typeof Schema.JsonObject.Type;

export const telegramError = (kind: MessengerError["kind"], code: string, retryAfterMs?: number) =>
  new MessengerError(kind, code, retryAfterMs, "Telegram");

interface RequestOptions {
  /** A write is never retried: an unknown outcome must stay distinguishable from a refusal. */
  write?: boolean;
  timeoutMs?: number;
}

function failure(status: number, description: string, retryAfterMs: number, write: boolean) {
  if (status === 429) return telegramError("retryable", "rate_limited", retryAfterMs);

  if (status === 401 || status === 404) return telegramError("configuration", "unauthorized");

  if (status === 409) {
    // A webhook stays until its owner removes it. Another poller holding the token can go away.
    return /webhook/i.test(description)
      ? telegramError("configuration", "webhook_active")
      : telegramError("retryable", "polling_conflict", 10_000);
  }

  if (status === 400 && /can't parse entities/i.test(description)) return telegramError("configuration", "entities");

  if (status === 400 || status === 403) return telegramError("configuration", "refused");

  return write ? telegramError("unknown_write", "provider_error") : telegramError("retryable", "provider_error", 5000);
}

/** Calls the Bot API. The token is part of the URL, so neither the URL nor provider text is ever logged. */
export async function telegramRequest(
  method: string,
  token: string,
  body: TelegramBody | FormData,
  signal: AbortSignal | undefined,
  transport: MessengerTransport | undefined,
  options: RequestOptions = {},
): Promise<Schema.Json> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const write = options.write === true;
  let response: Response;

  try {
    response = await (transport?.fetch ?? fetch)(
      new URL(`./bot${token}/${method}`, transport?.telegramApiBaseUrl ?? "https://api.telegram.org/"),
      {
        method: "POST",
        // Multipart uploads let fetch set the boundary in their content type.
        ...(body instanceof FormData
          ? { body }
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        redirect: "error",
        credentials: "omit",
        signal: requestSignal,
      },
    );
  } catch {
    signal?.throwIfAborted();

    throw write ? telegramError("unknown_write", "network") : telegramError("retryable", "network", 5000);
  }

  const parsed = decodeResponse(await response.json().catch(() => undefined));

  if (Option.isNone(parsed))
    throw write ? telegramError("unknown_write", "invalid_response") : telegramError("retryable", "invalid_response");
  const result = parsed.value;

  if (result.ok && result.result !== undefined) return result.result;
  const retryAfterMs = Math.min(3_600_000, Math.max(1000, (result.parameters?.retry_after ?? 5) * 1000));

  throw failure(result.error_code ?? response.status, result.description ?? "", retryAfterMs, write);
}
