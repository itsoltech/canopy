<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { tooltip } from "./tooltip.ts";

  /** Keep both ends of a ref visible, with its full value available on hover and focus. */
  let {
    text,
    hint = true,
    class: className,
  }: {
    text: string;
    /** Show the full text in a tooltip; off when the surrounding control has its own tooltip. */
    hint?: boolean;
    class?: ClassValue;
  } = $props();

  const middle = $derived(Math.ceil(text.length / 2));
</script>

<span
  class={["inline-flex max-w-full min-w-0 align-bottom", className]}
  aria-label={text}
  {@attach tooltip(hint ? text : undefined)}
>
  <span class="min-w-0 truncate" aria-hidden="true">{text.slice(0, middle)}</span>
  <span class="max-w-1/2 shrink-0 overflow-hidden whitespace-pre" dir="rtl" aria-hidden="true"
    ><bdi dir="ltr">{text.slice(middle)}</bdi></span
  >
</span>
