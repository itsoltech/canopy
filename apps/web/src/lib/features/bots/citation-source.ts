import type { ui } from "@canopy/contracts";
import type { ChatEntry } from "@canopy/domain/bot-chat";
import { highlightCitation } from "#lib/shared/ui/highlight-citation.ts";
import type { ChatHistory } from "./chat-history.ts";

/** Page in the cited message if needed, then let the virtual feed mount and reveal its row. */
export async function revealBotCitation(
  quote: ui.Quote,
  view: {
    readonly entries: readonly ChatEntry[];
    readonly root: HTMLElement | undefined;
    readonly history: ChatHistory | undefined;
    reveal: (id: string) => Promise<boolean>;
  },
): Promise<boolean> {
  const hasTarget = () =>
    view.entries.some((entry) => entry.kind === "message" && entry.message.id === quote.sourceItemId);

  while (view.root && !hasTarget()) {
    const history = view.history;

    if (!history) return false;
    const page = history.snapshot;

    if (!page?.historyHasMore) return false;
    await history.loadOlder();

    if (view.history !== history || history.snapshot?.historyBeforeSeq === page.historyBeforeSeq) break;
  }

  if (!view.root || !hasTarget() || !(await view.reveal(quote.sourceItemId))) return false;
  const target = view.root.querySelector<HTMLElement>(`[data-quote-item="${CSS.escape(quote.sourceItemId)}"]`);

  if (!target) return false;
  highlightCitation(target);

  return true;
}
