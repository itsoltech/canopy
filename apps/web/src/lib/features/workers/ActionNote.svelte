<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { sentence } from "./cli-tools.svelte.ts";

  /** The outcome of a click under the control: an error (announced) or a quiet note. Renders nothing without text. */
  let {
    error = "",
    note = "",
    class: className,
  }: { error?: string | undefined; note?: string | undefined; class?: ClassValue } = $props();
</script>

{#if error}<p class={["text-sm/5 text-pretty break-words text-rose-700 dark:text-rose-400", className]} role="alert">
    {sentence(error)}
  </p>
{:else if note}<p
    class={["text-sm/5 text-pretty break-words text-zinc-500 dark:text-zinc-400", className]}
    role="status"
  >
    {sentence(note)}
  </p>{/if}
