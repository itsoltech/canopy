<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /**
   * The surface of something in a chat that needs you (a question, an approval): a white card on the page
   * (slightly lighter than the page in dark mode), as wide as a long bubble. `labelledby` names the region.
   */
  let {
    labelledby,
    onkeydown,
    class: className,
    children,
  }: {
    labelledby: string;
    onkeydown?: ((event: KeyboardEvent) => void) | undefined;
    class?: ClassValue;
    children: Snippet;
  } = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  aria-labelledby={labelledby}
  class={[
    "w-full max-w-(--chat-bubble-width) min-w-0 rounded-2xl bg-white ring-1 ring-zinc-950/10 dark:bg-zinc-900 dark:ring-white/10",
    className,
  ]}
  {onkeydown}
>
  {@render children()}
</section>
