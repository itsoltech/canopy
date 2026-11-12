import { createContext, useContext } from "react";
import type { ui } from "@canopy/contracts";
import { router } from "expo-router";

export const PrCitationTarget = createContext<((quote: ui.Quote) => void) | undefined>(undefined);
export const usePrCitationTarget = () => useContext(PrCitationTarget);
const pending = new Map<string, ui.Quote>();
export const putPrCitation = (thread: string, quote: ui.Quote) => pending.set(thread, quote);

export const prCitationSender = (thread?: string) =>
  thread
    ? (quote: ui.Quote) => {
        putPrCitation(thread, quote);
        router.back();
      }
    : undefined;

export function takePrCitation(thread: string) {
  const quote = pending.get(thread);
  pending.delete(thread);

  return quote;
}
