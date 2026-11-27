import { Schema } from "effect";
import { MessengerError, type MessengerErrorKind } from "./messenger-error.ts";

export interface SlackCredentials {
  appToken: string;
  botToken: string;
}

/** Native Bun clients additionally support immediate termination and protocol heartbeat frames. */
export interface SlackWebSocket extends Omit<WebSocket, "ping" | "terminate"> {
  ping?: () => void;
  terminate?: () => void;
}

/** Overrides are trusted gateway/test dependencies, never account-controlled URLs. */
export interface SlackTransport {
  apiBaseUrl?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  connect?: (url: string) => SlackWebSocket;
  reconnectDelayMs?: number;
  waitForReconnect?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export type SlackErrorKind = MessengerErrorKind;

export class SlackMessengerError extends MessengerError {
  constructor(kind: SlackErrorKind, code: string, retryAfterMs?: number) {
    super(kind, code, retryAfterMs, "Slack");
    this.name = "SlackMessengerError";
  }
}

const SlackUser = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  real_name: Schema.optional(Schema.String),
  deleted: Schema.optional(Schema.Boolean),
  is_bot: Schema.optional(Schema.Boolean),
  profile: Schema.optional(Schema.Struct({ display_name: Schema.optional(Schema.String) })),
});

const ResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  team_id: Schema.optional(Schema.String),
  user_id: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  channel: Schema.optional(Schema.String),
  ts: Schema.optional(Schema.String),
  upload_url: Schema.optional(Schema.String),
  file_id: Schema.optional(Schema.String),
  bot: Schema.optional(Schema.Struct({ app_id: Schema.optional(Schema.String) })),
  file: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
      size: Schema.optional(Schema.Number),
      mode: Schema.optional(Schema.String),
      is_external: Schema.optional(Schema.Boolean),
      filetype: Schema.optional(Schema.String),
      url_private: Schema.optional(Schema.String),
      url_private_download: Schema.optional(Schema.String),
    }),
  ),
  channels: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        is_member: Schema.Boolean,
        is_private: Schema.Boolean,
        is_archived: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
  response_metadata: Schema.optional(Schema.Struct({ next_cursor: Schema.optional(Schema.String) })),
  members: Schema.optional(Schema.Array(Schema.Union([Schema.String, SlackUser]))),
});

const configurationCodes = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "forbidden_team",
  "enterprise_is_restricted",
  "ekm_access_denied",
  "two_factor_setup_required",
  "missing_scope",
  "not_allowed_token_type",
  "socket_mode_not_enabled",
  "app_not_installed",
  "access_denied",
  "accesslimited",
  "no_permission",
  "not_in_channel",
  "channel_not_found",
  "is_archived",
  "invalid_arguments",
  "invalid_arg_name",
  "invalid_blocks",
  "invalid_blocks_format",
  "invalid_form_data",
  "invalid_array_arg",
  "invalid_charset",
  "invalid_post_type",
  "missing_args",
  "missing_argument",
  "missing_post_type",
  "insecure_request",
  "deprecated_endpoint",
  "method_deprecated",
  "no_text",
  "msg_too_long",
  "restricted_action",
  "team_access_not_granted",
  "bot_not_found",
  "file_not_found",
  "file_deleted",
]);

function providerError(code: string, write: boolean, retryAfterMs: number): SlackMessengerError {
  if (code === "ratelimited" || code === "rate_limited")
    return new SlackMessengerError("retryable", "rate_limited", retryAfterMs);

  if (configurationCodes.has(code)) return new SlackMessengerError("configuration", code);

  // Slack documents partial success for fatal/internal errors. Unknown codes may contain secrets.
  return new SlackMessengerError(write ? "unknown_write" : "retryable", "provider_error");
}

export async function readSlackBody(response: Response, maxBytes: number) {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done) break;
      bytes += next.value.byteLength;

      if (bytes > maxBytes) return undefined;
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  return Buffer.concat(chunks, bytes);
}

async function responseBody(response: Response, maxBytes: number) {
  const bytes = await readSlackBody(response, maxBytes);

  if (!bytes) throw new Error("Response limit");

  return Schema.decodeUnknownSync(ResponseSchema)(JSON.parse(bytes.toString("utf8")));
}

export function checkSlackCredentials(credentials: SlackCredentials) {
  if (!/^xapp-[^\s]+$/.test(credentials.appToken) || !/^(?:xoxb-|xoxe\.xoxb-)[^\s]+$/.test(credentials.botToken))
    throw new SlackMessengerError("configuration", "invalid_token_type");
}

export async function slackRequest(
  method:
    | "auth.test"
    | "apps.connections.open"
    | "bots.info"
    | "chat.postMessage"
    | "conversations.list"
    | "conversations.members"
    | "files.info"
    | "files.getUploadURLExternal"
    | "files.completeUploadExternal"
    | "users.list",
  token: string,
  fields: URLSearchParams,
  signal?: AbortSignal,
  transport: SlackTransport = {},
) {
  signal?.throwIfAborted();
  const write = method === "chat.postMessage" || method === "files.completeUploadExternal";
  const timeout = AbortSignal.timeout(20_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const url = new URL(method, transport.apiBaseUrl ?? "https://slack.com/api/");
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const readFile = method === "files.info";

    if (readFile) url.search = fields.toString();
    else headers.set("Content-Type", "application/x-www-form-urlencoded");

    const response = await (transport.fetch ?? fetch)(url, {
      method: readFile ? "GET" : "POST",
      headers,
      ...(!readFile && { body: fields }),
      redirect: "error",
      credentials: "omit",
      signal: requestSignal,
    });

    const retrySeconds = Number(response.headers.get("retry-after") ?? "1");

    const retryAfterMs =
      Number.isFinite(retrySeconds) && retrySeconds >= 0 ? Math.max(1000, retrySeconds * 1000) : 1000;

    if (response.status === 429) {
      await response.body?.cancel();
      throw new SlackMessengerError("retryable", "rate_limited", retryAfterMs);
    }

    if (!response.ok) {
      await response.body?.cancel();

      if (response.status === 401 || response.status === 403)
        throw new SlackMessengerError("configuration", "access_denied");
      throw new SlackMessengerError(write ? "unknown_write" : "retryable", "http_error");
    }

    // A successful post echoes the rich-text elements as well as the fallback text.
    const result = await responseBody(response, write ? 2 * 1024 * 1024 : 256 * 1024);

    if (!result.ok) throw providerError(result.error ?? "", write, retryAfterMs);

    return result;
  } catch (error) {
    if (error instanceof SlackMessengerError) throw error;

    // Once a write was dispatched, even cancellation cannot prove that Slack did not accept it.
    if (!write && signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
    throw new SlackMessengerError(write ? "unknown_write" : "retryable", "transport_error");
  }
}

export async function slackSocketUrl(credentials: SlackCredentials, signal?: AbortSignal, transport?: SlackTransport) {
  const result = await slackRequest(
    "apps.connections.open",
    credentials.appToken,
    new URLSearchParams(),
    signal,
    transport,
  );

  try {
    const url = new URL(result.url ?? "");

    if (url.protocol !== "wss:" || !url.hostname.endsWith(".slack.com") || url.username || url.password)
      throw new Error("Invalid endpoint");

    return url.href;
  } catch {
    throw new SlackMessengerError("configuration", "invalid_socket_url");
  }
}
