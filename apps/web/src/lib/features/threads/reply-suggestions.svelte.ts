import { HttpError } from "#lib/shared/http.ts";
import type { ui } from "@canopy/contracts";
import { sendMessage } from "./api.ts";

class ReplyChoice {
  selected = $state("");
  status = $state<"idle" | "sending" | "sent" | "error">("idle");
  failure = $state("");
  retryable = $state(false);
  readonly requestId = crypto.randomUUID();
}

/** Retained with the thread, so virtual rows and navigation cannot unlock a selected group. */
export class ReplySuggestionsState {
  readonly #choices = new Map<string, ReplyChoice>();
  sending = $state(false);

  choice(itemId: string) {
    let choice = this.#choices.get(itemId);

    if (!choice) {
      choice = new ReplyChoice();
      this.#choices.set(itemId, choice);
    }

    return choice;
  }

  async send(
    threadId: string,
    itemId: string,
    text: string,
    available: () => boolean,
    received: (response: ui.SendMessageResponse) => void,
  ) {
    const choice = this.choice(itemId);

    if (this.sending || !available() || choice.status === "sent" || (choice.selected && choice.selected !== text))
      return;
    this.sending = true;
    choice.selected = text;
    choice.status = "sending";
    choice.failure = "";

    try {
      const response = await sendMessage(
        threadId,
        text,
        choice.requestId,
        { replySuggestionItemId: itemId },
        "queue",
        [],
        [],
        [],
        undefined,
        { signal: AbortSignal.timeout(45_000) },
      );

      choice.status = "sent";
      received(response);
    } catch (error) {
      choice.status = "error";
      choice.retryable = !(error instanceof HttpError) || ![400, 403, 404, 409].includes(error.status);
      choice.failure =
        error instanceof HttpError ? error.message : "Could not send this reply. Retry or write a message.";
    } finally {
      this.sending = false;
    }
  }
}
