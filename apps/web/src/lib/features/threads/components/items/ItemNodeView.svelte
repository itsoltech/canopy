<script lang="ts">
  import { untrack } from "svelte";
  import { provideMemoryScope } from "#lib/shared/ui/memory.ts";
  import { provideItemAwaiting, useThreadDirectory } from "../../thread-directory.ts";
  import type { ItemNode } from "../../timeline.ts";
  import ItemNodeView from "./ItemNodeView.svelte";
  import ItemView from "./ItemView.svelte";
  import { itemContents, provideLazyContent } from "./lazy-content.ts";
  import type { Item } from "@canopy/contracts";
  import { providerLabel } from "../../labels.ts";

  /**
   * An item and, nested inside it, the items that name it as parent (subagent work). The wrapper names the item
   * for quotes (selection.ts: `data-quote-item`, its thread) and is what a quote's "show source" highlights.
   */
  let { node }: { node: ItemNode } = $props();
  const directory = useThreadDirectory();
  let full = $state<{ key: string; item: Item }>();
  const contentKey = $derived(JSON.stringify([directory.currentId, node.entry.contentRef?.sha256]));

  const item = $derived((full?.key === contentKey ? full.item : itemContents.get(contentKey)) ?? node.entry.item);

  provideLazyContent(() =>
    node.entry.contentRef && item === node.entry.item
      ? {
          reference: node.entry.contentRef,
          threadId: directory.currentId,
          onload: (item) => {
            itemContents.set(contentKey, item);
            full = { key: contentKey, item };
          },
        }
      : undefined,
  );

  provideItemAwaiting(() => directory.awaiting(node.entry.id));

  // Nested items remember their own state (open details) apart from their parent's.
  provideMemoryScope(untrack(() => node.entry.id));
</script>

{#snippet nested()}
  {#each node.children as child (child.entry.id)}<ItemNodeView node={child} />{/each}
{/snippet}

<div
  class="min-w-0 rounded-lg"
  data-quote-item={node.entry.id}
  data-quote-thread={node.entry.fromThreadId || directory.currentId}
  data-quote-author={providerLabel(directory.thread(node.entry.fromThreadId || directory.currentId)?.provider ?? 0)}
  data-quote-time={node.entry.completedAt || node.entry.startedAt
    ? new Date(node.entry.completedAt ?? node.entry.startedAt!).toLocaleString()
    : directory.quoteTime?.(node.entry.turnId)}
>
  <ItemView
    {item}
    nested={node.children.length > 0 ? nested : undefined}
    turnEnded={directory.turnEnded?.(node.entry.turnId) ?? false}
  />
</div>
