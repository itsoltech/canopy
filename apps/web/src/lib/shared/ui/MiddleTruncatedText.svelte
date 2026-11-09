<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { tooltip } from "./tooltip.ts";

  /** Keeps both ends of a path or branch visible as its row narrows. */
  let { text, hint, class: className }: { text: string; hint?: string; class?: ClassValue } = $props();
  const characters = $derived(Array.from(text));
  const middle = $derived(Math.ceil(characters.length / 2));
</script>

<span class={["flex min-w-0", className]} aria-label={text} {@attach tooltip(hint ?? text)}>
  <span class="min-w-0 truncate">{characters.slice(0, middle).join("")}</span><span
    class="flex min-w-0 justify-end overflow-hidden"
    ><span class="whitespace-pre">{characters.slice(middle).join("")}</span></span
  >
</span>
