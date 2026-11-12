import { getContext, setContext } from "svelte";
import type { ui } from "@canopy/contracts";
import { useThreadDirectory } from "#lib/features/threads/thread-directory.ts";
import { safeHref } from "@canopy/domain/markdown";

type RevealCitation = (quote: ui.Quote) => Promise<boolean>;

const KEY = Symbol("citation-source");

export const provideCitationSource = (reveal: RevealCitation) => setContext(KEY, reveal);

export function useCitationSource(): RevealCitation {
  const directory = useThreadDirectory();

  const reveal =
    getContext<RevealCitation | undefined>(KEY) ??
    ((quote: ui.Quote) => directory.revealQuote?.(quote) ?? Promise.resolve(false));

  return async (quote) => {
    if (quote.pullRequest?.url) {
      const url = safeHref(quote.pullRequest.url);

      if (!url) return false;
      window.open(url, "_blank", "noopener,noreferrer");

      return true;
    }

    return reveal(quote);
  };
}
