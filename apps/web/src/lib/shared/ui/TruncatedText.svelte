<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { clipped } from "./clipped.ts";
  import { tooltip } from "./tooltip.ts";

  /**
   * One line of text that ends in an ellipsis when it does not fit, with the full text as a tooltip while it is
   * cut off (`hint` while it fits). Overlay rows (docs/ui-scale.md) stay one line high with names of any length.
   *
   *   <TruncatedText text={project.name} />
   */
  let {
    text,
    hint,
    class: className,
    children,
  }: { text?: string; hint?: string | undefined; class?: ClassValue; children?: Snippet } = $props();

  let full = $state<string>();
</script>

<span
  class={["block min-w-0 truncate", className]}
  {@attach clipped((fit) => (full = fit.clipped))}
  {@attach tooltip(full ?? hint)}
  >{#if children}{@render children()}{:else}{text}{/if}</span
>
