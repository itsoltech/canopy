import { tick } from "svelte";
import type { ui } from "@canopy/contracts";
import type { ChatEntry } from "@canopy/domain/bot-chat";
import { duration } from "#lib/shared/ui/motion.ts";

/** Bot citations share the editor's source action, including messages outside the loaded window. */
export async function revealBotCitation(
  quote: ui.Quote,
  view: {
    readonly entries: readonly ChatEntry[];
    readonly hasMore: boolean;
    readonly root: HTMLElement | undefined;
    load?: (() => Promise<void>) | undefined;
    show: (index: number) => void;
  },
): Promise<boolean> {
  const find = () =>
    view.entries.findIndex((entry) => entry.kind === "message" && entry.message.id === quote.sourceItemId);

  while (find() < 0 && view.hasMore && view.load) {
    const before = view.entries.length;
    await view.load();
    await tick();

    if (view.entries.length <= before) break;
  }

  const index = find();

  if (index < 0) return false;
  view.show(index);
  await tick();
  const target = view.root?.querySelector<HTMLElement>(`[data-quote-item="${CSS.escape(quote.sourceItemId)}"]`);

  if (!target) return false;
  target.scrollIntoView({ block: "nearest" });
  target.removeAttribute("data-flash");
  void target.offsetWidth;
  target.setAttribute("data-flash", "");
  setTimeout(() => target.removeAttribute("data-flash"), duration("very-slow") * 3);

  return true;
}
