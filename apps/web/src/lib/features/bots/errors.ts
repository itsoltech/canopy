export interface ReplyFailure {
  reason: string;
  model: boolean;
}

/**
 * Why a bot could not reply, in words for people. The gateway stores the technical cause (an HTTP status of
 * the model endpoint, a refused model, a limit); the chat shows this reason and keeps the cause for a tooltip.
 * `model`: changing the bot's model is the likely fix.
 */
export function replyFailure(detail: string): ReplyFailure {
  const status = /HTTP (\d{3})/.exec(detail)?.[1];

  if (status === "400" || status === "404" || /alias|does not offer|Choose a model/i.test(detail))
    return { reason: "the model isn't available", model: true };

  if (status === "401" || status === "403") return { reason: "the provider refused its credentials", model: false };

  if (status === "429") return { reason: "the provider is rate limiting it", model: false };

  if (status?.startsWith("5")) return { reason: "the provider had a problem", model: false };

  if (/limit reached|exceeds bot limits/i.test(detail)) return { reason: "it hit its step limit", model: false };

  if (/incomplete response/i.test(detail)) return { reason: "the answer got cut off", model: false };

  if (/endpoint unreachable/i.test(detail)) return { reason: "it couldn't reach the model provider", model: false };

  if (/endpoint unavailable/i.test(detail)) return { reason: "its provider is no longer set up", model: true };

  return { reason: "something went wrong", model: false };
}
