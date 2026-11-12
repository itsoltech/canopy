import type { ui } from "@canopy/contracts";
import type { useSession } from "../../state/session";
import { firstHistoryPage } from "../../state/history-page";

type Client = NonNullable<ReturnType<typeof useSession>["client"]>;

export type CitationSource = { entry: ui.TimelineItem; text?: never } | { text: string; entry?: never };

/** Source ids name an owned thread or bot. Both reads stay behind the gateway's owner checks. */
export async function readCitationSource(
  client: Client,
  id: string,
  itemId: string,
  signal: AbortSignal,
): Promise<CitationSource> {
  try {
    const update = await firstHistoryPage(async function* (signal) {
      for await (const update of client.api.watchThread(
        { threadId: id, targetItemId: itemId, pageSize: 1 },
        { signal, timeoutMs: 20_000 },
      ))
        if (!update.syncing) yield update;
    }, signal);

    const entry =
      update.change.case === "snapshot"
        ? update.change.value.items.find((item) => item.item?.itemId === itemId)
        : undefined;

    if (!entry) throw new Error("Source unavailable");

    return { entry };
  } catch (error) {
    if (signal.aborted) throw error;
  }

  let beforeSeq = 0n;

  for (;;) {
    const page = await firstHistoryPage(
      (signal) =>
        client.api.watchBotConversation({ botId: id, pageSize: 50, beforeSeq }, { signal, timeoutMs: 20_000 }),
      signal,
    );

    const message = page.messages.find((message) => message.id === itemId);

    if (message) return { text: message.text };

    if (!page.historyHasMore || page.historyBeforeSeq === beforeSeq) throw new Error("Source unavailable");
    beforeSeq = page.historyBeforeSeq;
  }
}
