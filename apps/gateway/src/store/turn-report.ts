import { noticePresentation } from "@canopy/domain/notice-presentation";

import { truncate } from "./agent-bus-types.ts";
import { storageText } from "./event-text.ts";

export function reportFailureReason(error: string | null): string {
  if (!error?.trim()) return "";
  const { message } = noticePresentation({ message: error.trim(), code: "", dataJson: "" });

  return storageText(message);
}

/** Partial output stays below the terminal failure, inside the same recipient's text budget. */
export function turnReport(
  status: string,
  error: string | null,
  text: string | null,
  limit: number,
  totalLength?: number,
) {
  if (status === "failed") {
    const reason = reportFailureReason(error).replace(/\s+/gu, " ").trim();
    const detail = reason.length <= 1_000 ? reason : `${reason.slice(0, 999).toWellFormed()}…`;
    const failure = detail ? `Turn failed: ${detail}` : "Turn failed. No error details were recorded.";

    const message = text?.trim()
      ? `${failure}\n\n${text.slice(0, limit - failure.length - 2).toWellFormed()}`
      : failure;

    return { message, failure };
  }

  if (text?.trim())
    return {
      message: (totalLength === undefined ? text.slice(0, limit) : truncate(text, limit, totalLength)).toWellFormed(),
    };

  if (status === "interrupted" || status === "cancelled")
    return { message: `The turn was ${status} before it produced a final message.` };

  return { message: "The turn completed without a final message." };
}
