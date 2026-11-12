import { getContext, setContext } from "svelte";
import type { ui } from "@canopy/contracts";
import { useThreadDirectory } from "#lib/features/threads/thread-directory.ts";

type RevealCitation = (quote: ui.Quote) => Promise<boolean>;

const KEY = Symbol("citation-source");

export const provideCitationSource = (reveal: RevealCitation) => setContext(KEY, reveal);

export function useCitationSource(): RevealCitation {
  const directory = useThreadDirectory();

  return (
    getContext<RevealCitation | undefined>(KEY) ?? ((quote) => directory.revealQuote?.(quote) ?? Promise.resolve(false))
  );
}
