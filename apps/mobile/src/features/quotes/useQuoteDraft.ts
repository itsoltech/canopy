import { useState } from "react";
import { Alert } from "react-native";
import type { ui } from "@canopy/contracts";
import { QUOTE_LIMITS } from "@canopy/domain";
import { useUpdateBlocker } from "../updates/useUpdateBlocker";
import type { MessageDraft } from "../composer/useMessageDraft";

export function useQuoteDraft(
  blocked: () => boolean = () => false,
  options: {
    current?: { current: readonly ui.Quote[] };
    onChange?: () => void;
  } = {},
  message?: MessageDraft,
) {
  const [local, setLocal] = useState<readonly ui.Quote[]>([]);
  const quotes = message ? (message.value.quotes ?? []) : (options.current?.current ?? local);

  const setQuotes = (change: (current: readonly ui.Quote[]) => readonly ui.Quote[]) => {
    const next = change(options.current?.current ?? quotes);

    if (options.current) options.current.current = next;
    setLocal(next);
    options.onChange?.();
  };

  useUpdateBlocker(() => quotes.length > 0);

  return {
    quotes,
    add(quote: ui.Quote) {
      if (blocked()) return;

      if (quotes.length >= QUOTE_LIMITS.maxQuotes) {
        Alert.alert("Quote limit reached", "Remove a quote before adding another.");

        return;
      }

      if (message) message.addQuote(quote);
      else setQuotes((current) => [...current, quote]);
    },
    edit(index: number, quote: ui.Quote) {
      if (blocked()) return;

      if (message) message.badges.editQuote?.(index, quote);
      else setQuotes((current) => current.map((item, at) => (at === index ? quote : item)));
    },
    remove(index: number) {
      if (blocked()) return;

      if (message) message.badges.removeQuote?.(index);
      else setQuotes((current) => current.filter((_quote, at) => at !== index));
    },
    clear() {
      setQuotes(() => []);
    },
  };
}
