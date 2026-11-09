import { useState } from "react";
import { Alert } from "react-native";
import type { ui } from "@canopy/contracts";
import { QUOTE_LIMITS } from "@canopy/domain";

export function useQuoteDraft() {
  const [quotes, setQuotes] = useState<readonly ui.Quote[]>([]);

  return {
    quotes,
    add(quote: ui.Quote) {
      if (quotes.length >= QUOTE_LIMITS.maxQuotes) {
        Alert.alert("Quote limit reached", "Remove a quote before adding another.");

        return;
      }

      setQuotes((current) => [...current, quote]);
    },
    edit(index: number, quote: ui.Quote) {
      setQuotes((current) => current.map((item, at) => (at === index ? quote : item)));
    },
    remove(index: number) {
      setQuotes((current) => current.filter((_quote, at) => at !== index));
    },
    clear() {
      setQuotes([]);
    },
  };
}
