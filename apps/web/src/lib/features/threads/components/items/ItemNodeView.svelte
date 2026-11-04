<script lang="ts">
  import { untrack } from "svelte";
  import { provideMemoryScope } from "#lib/shared/ui/memory.ts";
  import { provideItemAwaiting, useThreadDirectory } from "../../thread-directory.ts";
  import type { ItemNode } from "../../timeline.ts";
  import ItemNodeView from "./ItemNodeView.svelte";
  import ItemView from "./ItemView.svelte";

  /**
   * An item and, nested inside it, the items that name it as parent (subagent work). The wrapper names the item
   * for quotes (selection.ts: `data-quote-item`, its thread) and is what a quote's "show source" highlights.
   */
  let { node }: { node: ItemNode } = $props();
  const directory = useThreadDirectory();

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
>
  <ItemView
    item={node.entry.item}
    nested={node.children.length > 0 ? nested : undefined}
    turnEnded={directory.turnEnded?.(node.entry.turnId) ?? false}
  />
</div>
