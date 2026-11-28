import { tick } from "svelte";
import type { Item } from "@canopy/contracts";
import { highlightCitation } from "#lib/shared/ui/highlight-citation.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { loadItemContent } from "./components/items/lazy-content.ts";
import type { FeedRow } from "./feed.ts";
import { itemContents } from "./item-content-cache.ts";
import type { ThreadState } from "./thread-state.svelte.ts";
import type { TimelineEntry } from "./thread-types.ts";
import type { ThreadRewind } from "./rewind-state.svelte.ts";
import type { WorkFolds } from "./work-folds.svelte.ts";
import { itemPath } from "./timeline.ts";

interface ItemRevealContext {
  readonly view: ThreadState;
  readonly folds: WorkFolds;
  readonly rewind: ThreadRewind;
  readonly rows: readonly FeedRow[];
  readonly feed: { reveal(key: string): Promise<boolean> } | undefined;
  readonly region: HTMLElement | undefined;
  readonly openHistory: () => void;
}

/** Nested work mounts only after its parent's activity disclosure opens. */
async function revealNested(row: HTMLElement, path: TimelineEntry[], signal: AbortSignal) {
  const find = (id: string) => row.querySelector<HTMLElement>(`[data-quote-item="${CSS.escape(id)}"]`);
  let element = find(path[0]!.id);

  for (const child of path.slice(1)) {
    if (signal.aborted || !element) return;

    if (!find(child.id)) {
      const frame = element.querySelector<HTMLDetailsElement>(":scope > [data-item-frame] > details");

      if (!frame || frame.open) return;
      const toggled = new Promise<void>((resolve) => frame.addEventListener("toggle", () => resolve(), { once: true }));
      frame.open = true;
      await toggled;
      await tick();
    }

    element = find(child.id);
  }

  return element;
}

/** Older pages, work folds and virtual rows can each be needed to reach an item.
 * A later jump or a thread change cancels the earlier request without surfacing a missing-source error.
 */
export function createItemReveal(threadId: () => string, read: () => ItemRevealContext) {
  let current: AbortController | undefined;

  $effect.pre(() => {
    threadId();

    return () => current?.abort();
  });

  async function revealItem(itemId: string, source?: "artifact"): Promise<boolean> {
    current?.abort();
    current = new AbortController();
    const { signal } = current;
    const id = threadId();
    const { view, folds, rewind, openHistory } = read();

    // Artifacts belong to this thread. A fork can inherit an item with the same provider-issued id.
    const find = () =>
      view.ownEntries.find((entry) => entry.id === itemId) ??
      (source === "artifact" ? undefined : view.inheritedEntries.find((entry) => entry.id === itemId));

    await view.history.loadUntil(() => {
      const entry = find();

      return (
        !!entry &&
        (!entry.turnId || !view.snapshot?.historyHasMore || view.turns.some((turn) => turn.id === entry.turnId))
      );
    }, signal);

    if (signal.aborted) return true;
    const entry = find();

    if (!entry) return false;
    const path = itemPath(entry.inherited ? view.inheritedEntries : view.ownEntries, entry);
    const top = path[0]!;

    if (entry.inherited) openHistory();
    const rewound = !entry.inherited && view.ownTurns.find((turn) => turn.id === entry.turnId)?.rewindId;

    if (rewound) rewind.show(rewound);
    const fold = folds.foldOf(top.id);

    if (fold && !folds.open.has(fold)) folds.toggle(fold, true);
    await tick();

    if (signal.aborted) return true;

    const group = read().rows.find(
      (row) => row.kind === "work-group" && row.turn.id === entry.turnId && row.items.includes(`item:${top.id}`),
    );

    if (group) folds.toggleGroup(group.key.replace(/^history:[^:]+:/, ""), true);
    await tick();

    if (signal.aborted) return true;
    const { rows, feed } = read();

    const target = rows.find(
      (row) =>
        (row.kind === "timeline" || row.kind === "answer") &&
        row.row?.kind === "item" &&
        row.row.node.entry.fromThreadId === top.fromThreadId &&
        row.row.node.entry.id === top.id,
    );

    if (!target) return false;
    const revealed = await feed?.reveal(target.key);

    if (signal.aborted) return true;

    if (!revealed) return false;
    await tick();

    if (signal.aborted) return true;
    const row = read().region?.querySelector<HTMLElement>(`article[data-key="${CSS.escape(target.key)}"]`);

    if (!row) return false;
    const element = await revealNested(row, path, signal);

    if (signal.aborted) return true;

    // Some user-input rows render directly, without an ItemNodeView wrapper.
    if (!element) return source !== "artifact" && path.length === 1;
    let destination = element;

    if (source === "artifact" && entry.item.content.case === "agentMessage") {
      // The Markdown image can be below the retained text preview of a large message.
      if (entry.contentRef && !itemContents.get(id, entry.contentRef)) {
        try {
          await loadItemContent(id, entry.contentRef, signal);
          await tick();
        } catch {
          return signal.aborted;
        }
      }

      destination = element.querySelector<HTMLElement>("[data-inline-image]") ?? element;
    }

    if (signal.aborted) return true;
    destination.scrollIntoView({ block: "nearest" });
    highlightCitation(destination);

    return true;
  }

  async function showArtifact(item: Item) {
    const jump = revealItem(item.itemId, "artifact");
    const signal = current?.signal;

    if ((await jump) || signal?.aborted) return;
    toast(read().view.history.error || "Could not show this artifact in the thread.", {
      tone: "error",
      action: {
        label: "Retry",
        run: () => {
          if (!signal?.aborted) void showArtifact(item);
        },
      },
    });
  }

  return { revealItem, showArtifact };
}
