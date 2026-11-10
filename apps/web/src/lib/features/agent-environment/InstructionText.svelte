<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  let {
    content,
    empty = "(No managed text)",
    class: className,
  }: {
    content: string;
    empty?: string;
    class?: ClassValue;
  } = $props();
</script>

<pre
  class={[
    "scroll-stable overflow-auto rounded-lg bg-zinc-950/4 p-4 font-mono text-sm/6 break-words whitespace-pre-wrap dark:bg-white/5",
    className,
  ]}>{content || empty}</pre>
