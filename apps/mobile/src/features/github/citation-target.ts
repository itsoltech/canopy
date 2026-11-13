import { createContext, useContext } from "react";
import type { ui } from "@canopy/contracts";
import { router } from "expo-router";
import { publishPrDraft } from "./draft-events";

export const PrCitationTarget = createContext<((quote: ui.Quote) => void) | undefined>(undefined);
export const usePrCitationTarget = () => useContext(PrCitationTarget);
const pending = new Map<string, ui.Quote>();

export const putPrCitation = (thread: string, quote: ui.Quote) => {
  pending.set(thread, quote);
  publishPrDraft(thread);
};

export const prCitationSender = (thread?: string, onReturn?: () => void) =>
  thread
    ? (quote: ui.Quote) => {
        putPrCitation(thread, quote);

        if (onReturn) onReturn();
        else router.back();
      }
    : undefined;

export function takePrCitation(thread: string) {
  const quote = pending.get(thread);
  pending.delete(thread);

  return quote;
}
