import { safeFileName } from "@canopy/domain";
import { SlackMessengerError, readSlackBody, slackRequest, type SlackTransport } from "./slack-http.ts";

interface SlackFileDownload {
  fileId: string;
  token: string;
  maxBytes: number;
  signal?: AbortSignal;
  transport?: SlackTransport;
}

const downloadOrigin = "https://files.slack.com";
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

const accessCodes = new Set([
  "access_denied",
  "accesslimited",
  "account_inactive",
  "ekm_access_denied",
  "enterprise_is_restricted",
  "file_deleted",
  "file_not_found",
  "forbidden_team",
  "invalid_auth",
  "no_permission",
  "not_allowed_token_type",
  "not_authed",
  "not_in_channel",
  "team_access_not_granted",
  "token_expired",
  "token_revoked",
]);

const configurationCodes = new Set([
  "file_not_hosted",
  "file_too_large",
  "invalid_file_redirect",
  "invalid_file_response",
  "invalid_file_url",
  "missing_scope",
]);

export function slackFileId(value: string): boolean {
  return /^F[A-Z0-9]{1,31}$/.test(value);
}

function downloadUrl(value: string, previous?: URL) {
  const url = URL.parse(value, previous?.href);

  if (!url || url.protocol !== "https:" || url.origin !== downloadOrigin || url.username || url.password || url.hash)
    throw new SlackMessengerError("configuration", previous ? "invalid_file_redirect" : "invalid_file_url");

  return url;
}

function safeFailure(error: SlackMessengerError) {
  if (accessCodes.has(error.code)) return new SlackMessengerError("configuration", "access_denied");

  if (configurationCodes.has(error.code)) return new SlackMessengerError("configuration", error.code);

  if (error.code === "rate_limited") return new SlackMessengerError("retryable", "rate_limited", error.retryAfterMs);

  return new SlackMessengerError("retryable", "file_unavailable");
}

async function downloadResponse(start: URL, token: string, signal: AbortSignal, transport?: SlackTransport) {
  let url = start;
  const request = transport?.fetch ?? fetch;

  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();

    const response = await request(url, {
      headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "identity" },
      credentials: "omit",
      redirect: "manual",
      signal,
    });

    if (response.status === 200) return response;
    await response.body?.cancel().catch(() => {});

    if ([401, 403, 404, 410].includes(response.status)) throw new SlackMessengerError("configuration", "access_denied");

    if (response.status === 429) throw new SlackMessengerError("retryable", "rate_limited");

    if (!redirectStatuses.has(response.status)) throw new SlackMessengerError("retryable", "file_unavailable");
    const location = response.headers.get("location");

    if (!location || redirects >= 2) throw new SlackMessengerError("configuration", "invalid_file_redirect");
    url = downloadUrl(location, url);
  }
}

export async function downloadSlackFile(
  input: SlackFileDownload,
): Promise<{ fileId: string; name: string; data: Uint8Array }> {
  const { fileId, token, maxBytes, signal, transport } = input;

  if (!slackFileId(fileId)) throw new SlackMessengerError("configuration", "invalid_file_id");

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new SlackMessengerError("configuration", "invalid_file_limit");

  try {
    const result = await slackRequest("files.info", token, new URLSearchParams({ file: fileId }), signal, transport);
    const file = result.file;

    if (!file || file.id !== fileId) throw new SlackMessengerError("configuration", "invalid_file_response");

    if (file.is_external || file.mode === "external" || file.filetype === "remote")
      throw new SlackMessengerError("configuration", "file_not_hosted");
    const source = file.url_private_download || file.url_private;

    if (!source) throw new SlackMessengerError("configuration", "access_denied");

    if ((file.size ?? 0) > maxBytes) throw new SlackMessengerError("configuration", "file_too_large");
    const url = downloadUrl(source);
    const timeout = AbortSignal.timeout(20_000);

    const response = await downloadResponse(
      url,
      token,
      signal ? AbortSignal.any([signal, timeout]) : timeout,
      transport,
    );

    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new SlackMessengerError("configuration", "file_too_large");
    }

    const data = await readSlackBody(response, maxBytes);

    if (!data) throw new SlackMessengerError("configuration", "file_too_large");
    const name = safeFileName(file.name && (!token || !file.name.includes(token)) ? file.name : fileId);

    return { fileId, name, data };
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");

    if (error instanceof SlackMessengerError) throw safeFailure(error);
    throw new SlackMessengerError("retryable", "file_unavailable");
  }
}
