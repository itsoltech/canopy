<script lang="ts">
  import type { Snippet } from "svelte";
  import { untrack } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import { provideMemoryScope, type UiMemory } from "../memory.ts";

  /**
   * One article of a VirtualFeed: measured while mounted (`measure`), and the scope of the UI memory
   * its content uses, so the row looks the same when it is scrolled back into view. A new row enters once
   * (`enter`: motion.css `t-rise` for one that arrived, `t-reveal` for the first rows replacing a
   * skeleton); both are transform, opacity and blur only, so its measured height is final from the start.
   */
  let {
    key,
    position,
    count,
    memory,
    measure,
    enter,
    children,
  }: {
    key: string;
    position: number;
    count: number;
    memory: UiMemory;
    measure: Attachment<HTMLElement>;
    enter?: "rise" | "reveal" | undefined;
    children: Snippet;
  } = $props();
  const entrance = untrack(() => enter);

  provideMemoryScope(
    untrack(() => key),
    untrack(() => memory),
  );
</script>

<article data-key={key} aria-posinset={position} aria-setsize={count} tabindex="-1" class={["min-w-0 rounded-lg focus-ring", entrance === "rise" && "t-rise", entrance === "reveal" && "t-reveal"]} {@attach measure}>
  {@render children()}
</article>
