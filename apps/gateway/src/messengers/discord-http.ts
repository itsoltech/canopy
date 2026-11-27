import { Option, Schema } from "effect";
import { MessengerError } from "./messenger-error.ts";
import type { MessengerTransport } from "./provider.ts";

export const discordError = (kind: MessengerError["kind"], code: string, retryAfterMs?: number) =>
  new MessengerError(kind, code, retryAfterMs, "Discord");

const RateLimit = Schema.Struct({ retry_after: Schema.optional(Schema.Number) });

export type DiscordBody = typeof Schema.JsonObject.Type;

interface RequestOptions {
  method?: "GET" | "POST";
  body?: DiscordBody | FormData;
  /** A write is never retried: an unknown outcome must stay distinguishable from a refusal. */
  write?: boolean;
}

async function retryAfter(response: Response) {
  const parsed = Option.getOrUndefined(
    Schema.decodeUnknownOption(RateLimit)(await response.json().catch(() => undefined)),
  );

  return Math.min(3_600_000, Math.max(1000, Math.ceil((parsed?.retry_after ?? 5) * 1000)));
}

/** Calls the REST API as the bot. Provider bodies and the token are never logged or returned in errors. */
export async function discordRequest(
  path: string,
  token: string,
  signal: AbortSignal | undefined,
  transport: MessengerTransport | undefined,
  options: RequestOptions = {},
): Promise<Schema.Json> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(options.body instanceof FormData ? 120_000 : 20_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const write = options.write === true;
  let response: Response;

  try {
    response = await (transport?.fetch ?? fetch)(
      new URL(path, transport?.discordApiBaseUrl ?? "https://discord.com/api/v10/"),
      {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bot ${token}`,
          "User-Agent": "DiscordBot (canopy, 1)",
          // Multipart uploads let fetch set the boundary in their content type.
          ...(options.body && !(options.body instanceof FormData) && { "Content-Type": "application/json" }),
        },
        ...(options.body && {
          body: options.body instanceof FormData ? options.body : JSON.stringify(options.body),
        }),
        redirect: "error",
        credentials: "omit",
        signal: requestSignal,
      },
    );
  } catch {
    signal?.throwIfAborted();

    throw write ? discordError("unknown_write", "network") : discordError("retryable", "network", 5000);
  }

  if (response.status === 429) throw discordError("retryable", "rate_limited", await retryAfter(response));

  if (response.status === 401) throw discordError("configuration", "unauthorized");

  if (response.status >= 400 && response.status < 500) throw discordError("configuration", "refused");

  if (!response.ok)
    throw write ? discordError("unknown_write", "provider_error") : discordError("retryable", "provider_error", 5000);

  const body = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(await response.json().catch(() => null)));

  if (body === undefined || body === null)
    throw write ? discordError("unknown_write", "invalid_response") : discordError("retryable", "invalid_response");

  return body;
}
