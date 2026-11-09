/** Stable failure classes shared by gateway inference, harnesses and clients. */
export const FAILURE_CODES = [
  "auth_required",
  "cli_missing",
  "model_unavailable",
  "usage_limit",
  "network",
  "stream_cut_off",
  "process_exit",
  "configuration",
  "connection_changed",
  "tool_approval",
  "provider_unavailable",
  "internal",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/** Native codes are retained for diagnostics; classification also handles older workers' prose. */
export function classifyFailure(message: string, code = ""): FailureCode {
  const explicit = FAILURE_CODES.find((value) => value === code);

  if (explicit) return explicit;
  const text = `${code.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)} ${message}`;

  if (
    /This chat uses .+, but your current provider is .+\. Switch to .+ to continue\./i.test(message) ||
    /This chat uses model provider .+, which is no longer configured\. Restore this provider['’]s configuration to continue\./i.test(
      message,
    )
  )
    return "connection_changed";

  if (
    /\b401\b|unauthenticated|not authenticated|not (?:signed|logged) in|no (?:Claude|Codex|Grok).*login|authentication|unauthorized|invalid.api.key|expired.*(?:token|login)|(?:token|login).*expired/i.test(
      text,
    )
  )
    return "auth_required";

  if (
    /ENOENT|cannot start .*CLI|Claude Code is not installed|not found or not runnable|(?:CLI|executable|binary).*(?:not found|not installed|not runnable)|command not found/i.test(
      text,
    )
  )
    return "cli_missing";

  if (
    /\b404\b|model.?not.?found|model.*(?:not available|unavailable|does not exist|not supported)|does not offer|choose a (?:concrete )?model|alias/i.test(
      text,
    )
  )
    return "model_unavailable";

  if (
    /\b429\b|usage.?limit|rate.?limit|quota|insufficient.?credits|credit balance|billing_error|session_budget_exceeded|exhausted|limit reached|hit.*limit|exceeds bot limits|max_turn(?:_requests|s)|too.?many.?requests/i.test(
      text,
    )
  )
    return "usage_limit";

  if (
    /\b403\b|\b400\b|\b422\b|bad_request|context_window_exceeded|endpoint unavailable|provider.*(?:unavailable|not configured)|invalid.*config|missing.*(?:key|profile)/i.test(
      text,
    )
  )
    return "configuration";

  if (
    /timeout|timed out|ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|endpoint unreachable|connection.*(?:failed|closed|lost)|http_connection_failed/i.test(
      text,
    )
  )
    return "network";

  if (
    /max_tokens|length|incomplete response|stream.*(?:cut|closed|disconnect|end|failed)|response.*truncat/i.test(text)
  )
    return "stream_cut_off";

  if (/process.?exit|exited|std(?:in|out) closed|CLI.*(?:died|crash)/i.test(text)) return "process_exit";

  if (/\b5\d\d\b|server.?error|overloaded|provider.*(?:failed|error)/i.test(text)) return "provider_unavailable";

  return "internal";
}

/** Diagnostic text only: URLs, credentials and common token formats must never reach error details. */
export function safeFailureDetail(message: string, secrets: readonly string[] = []): string {
  let text = message;

  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");

  return redactCredentials(text.replace(/https?:\/\/[^\s"'<>]+/gi, "[endpoint]")).slice(0, 8000);
}

/** Bearer tokens, `key=value` credentials and common API key formats. */
export function redactCredentials(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [redacted]")
    .replace(
      /((?:[\w-]*(?:api[_-]?key|token|password|secret|credential)[\w-]*)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1[redacted]",
    )
    .replace(/\b(?:xai-|sk-)[\w-]+/g, "[redacted]");
}

export class ProviderFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
    readonly source: "provider" | "harness" | "platform" = "provider",
  ) {
    super(safeFailureDetail(message));
    this.name = "ProviderFailure";
  }
}
