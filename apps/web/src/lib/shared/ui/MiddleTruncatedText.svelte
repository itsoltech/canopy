<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { tooltip } from "./tooltip.ts";

  /**
   * Keep both ends of a ref visible, with its full value available on hover and focus. Inside a row that opens its
   * own hover card, `hint="title"` keeps the full value as a native title instead of a second floating tooltip.
   */
  let {
    text,
    hint = "tooltip",
    class: className,
  }: { text: string; hint?: "tooltip" | "title"; class?: ClassValue } = $props();

  const middle = $derived(Math.ceil(text.length / 2));
</script>

<span
  class={["inline-flex max-w-full min-w-0 align-bottom", className]}
  aria-label={text}
  title={hint === "title" ? text : undefined}
  {@attach tooltip(hint === "tooltip" ? text : undefined)}
>
  <span class="min-w-0 truncate" aria-hidden="true">{text.slice(0, middle)}</span>
  <span class="max-w-1/2 shrink-0 overflow-hidden whitespace-pre" dir="rtl" aria-hidden="true"
    ><bdi dir="ltr">{text.slice(middle)}</bdi></span
  >
</span>
