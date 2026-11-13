<script lang="ts">
  import type { Snippet } from "svelte";
  import { untrack } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import { provideMemoryScope, type UiMemory } from "../memory.ts";
  import { expand, stagger } from "../motion.ts";

  /**
   * One article of a VirtualFeed: measured while mounted (`measure`), and the scope of the UI memory
   * its content uses, so the row looks the same when it is scrolled back into view. A new row enters once
   * (`enter`: motion.css `t-rise` for one that arrived, `t-reveal` for the first rows replacing a
   * skeleton, `t-unfold` for rows of a fold that opened, staggered by `order`); all preserve layout,
   * opacity and blur only, so its measured height is final from the start. Layout/style containment
   * bounds streaming reflow to this row without clipping shadows, focus rings or overlays.
   */
  let {
    key,
    position,
    count,
    memory,
    measure,
    enter,
    exiting,
    children,
  }: {
    key: string;
    position: number;
    count: number;
    memory: UiMemory;
    measure: Attachment<HTMLElement>;
    enter?: { kind: "rise" | "reveal" | "unfold"; order: number } | undefined;
    /** Animate removed work rows; virtual unmounts remain immediate. Evaluated when leaving. */
    exiting: () => boolean;
    children: Snippet;
  } = $props();

  const entrance = untrack(() => enter?.kind);
  const delay = untrack(() => (enter?.kind === "unfold" ? stagger(enter.order) : 0));
  const collapse = (node: HTMLElement) => (exiting() ? expand(node, { instantReduced: true }) : { duration: 0 });

  provideMemoryScope(
    untrack(() => key),
    untrack(() => memory),
  );
</script>

<article
  data-key={key}
  aria-posinset={position}
  aria-setsize={count}
  tabindex="-1"
  class={["min-w-0 rounded-lg focus-ring [contain:layout_style]", entrance && `t-${entrance}`]}
  style:--t-delay={delay ? `${delay}ms` : undefined}
  {@attach measure}
  out:collapse
>
  {@render children()}
</article>
