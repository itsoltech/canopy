<script lang="ts">
  import type { Snippet } from "svelte";
  import { untrack } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import { provideMemoryScope, type UiMemory } from "../memory.ts";

  /**
   * One article of a VirtualFeed: measured while mounted (`measure`), and the scope of the UI memory
   * its content uses, so the row looks the same when it is scrolled back into view.
   */
  let {
    key,
    position,
    count,
    memory,
    measure,
    children,
  }: { key: string; position: number; count: number; memory: UiMemory; measure: Attachment<HTMLElement>; children: Snippet } = $props();

  provideMemoryScope(
    untrack(() => key),
    untrack(() => memory),
  );
</script>

<article data-key={key} aria-posinset={position} aria-setsize={count} tabindex="-1" class="min-w-0 rounded-lg focus-ring" {@attach measure}>
  {@render children()}
</article>
