import { useCallback, useEffect, useRef } from "react";
import { useFocusEffect } from "expo-router";
import type { MessageDraft } from "../composer/useMessageDraft";
import { takeContext } from "./context-draft";
import { takePrCitation } from "./citation-target";
import { QUOTE_LIMITS } from "@canopy/domain";
import { subscribePrDraft } from "./draft-events";

export function useContextDraft(id: string, message: MessageDraft, onError: (message: string) => void) {
  const latest = useRef({ message, onError });
  latest.current = { message, onError };

  const consume = useCallback(() => {
    const quote = takePrCitation(id);

    if (quote) {
      if ((latest.current.message.value.quotes?.length ?? 0) >= QUOTE_LIMITS.maxQuotes)
        latest.current.onError("Quote limit reached. Remove a quote, then retry.");
      else latest.current.message.addQuote(quote);
    }

    const context = takeContext(id);

    if (!context?.attachment) return;
    const draft = latest.current.message;

    try {
      draft.files.accept(context.attachment, context.scope);

      if (context.prompt) draft.appendText(context.prompt);
    } catch {
      latest.current.onError("Could not add PR context. Remove an attachment, then retry.");
    }
  }, [id]);

  useFocusEffect(consume);
  useEffect(() => subscribePrDraft(id, consume), [id, consume]);
}
