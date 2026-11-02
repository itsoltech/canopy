<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** Why a tool call failed or was refused, as written (line breaks kept), in a red well that scrolls when long. */
  let { text, class: className }: { text: string; class?: ClassValue } = $props();
</script>

<p class={["max-h-48 overflow-auto rounded-lg bg-rose-50 p-3 text-base/6 break-words whitespace-pre-wrap text-rose-900 sm:text-sm/6 dark:bg-rose-400/10 dark:text-rose-200", className]}>{text}</p>
