import { slackRequest, SlackMessengerError, type SlackCredentials, type SlackTransport } from "./slack-http.ts";
import type { OutboundFile } from "./types.ts";

/** Slack hosts upload URLs on its own domain; a test transport may serve them from its API origin. */
function uploadTarget(value: string | undefined, transport: SlackTransport | undefined) {
  try {
    const url = new URL(value ?? "");
    const testOrigin = transport?.apiBaseUrl ? new URL(transport.apiBaseUrl).origin : undefined;
    const slack = url.protocol === "https:" && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"));

    if ((slack || url.origin === testOrigin) && !url.username && !url.password) return url;
  } catch {
    // Reported below with a fixed code; the URL itself is never logged.
  }

  throw new SlackMessengerError("unknown_write", "invalid_upload_url");
}

/**
 * Uploads file bytes without sharing them. Nothing is visible in Slack until `shareSlackFiles`, so a refused
 * upload (for example a missing files:write scope) leaves the whole reply unsent.
 */
export async function uploadSlackFiles(
  credentials: SlackCredentials,
  files: readonly OutboundFile[],
  signal: AbortSignal,
  transport?: SlackTransport,
) {
  const uploaded: { id: string; title: string }[] = [];

  for (const file of files) {
    const reserved = await slackRequest(
      "files.getUploadURLExternal",
      credentials.botToken,
      new URLSearchParams({ filename: file.name, length: String(file.data.byteLength) }),
      signal,
      transport,
    );

    if (!reserved.file_id) throw new SlackMessengerError("retryable", "invalid_upload_reservation");
    const target = uploadTarget(reserved.upload_url, transport);
    let response: Response;

    try {
      response = await (transport?.fetch ?? fetch)(target, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(file.data),
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      });
    } catch {
      throw new SlackMessengerError("retryable", "upload_failed");
    }

    await response.body?.cancel();

    if (!response.ok) throw new SlackMessengerError("retryable", "upload_failed");
    uploaded.push({ id: reserved.file_id, title: file.name });
  }

  return uploaded;
}

/** Shares uploaded files in the reply's channel and thread: the visible write. */
export async function shareSlackFiles(
  credentials: SlackCredentials,
  files: readonly { id: string; title: string }[],
  channelId: string,
  threadId: string,
  signal: AbortSignal,
  transport?: SlackTransport,
) {
  await slackRequest(
    "files.completeUploadExternal",
    credentials.botToken,
    new URLSearchParams({
      files: JSON.stringify(files),
      channel_id: channelId,
      ...(threadId && { thread_ts: threadId }),
    }),
    signal,
    transport,
  );

  return "";
}
