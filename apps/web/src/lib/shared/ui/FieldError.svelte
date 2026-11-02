<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** A field's validation message, announced when it appears. Renders nothing without a message. */
  let { message, id, class: className }: { message: string | undefined; id?: string; class?: ClassValue } = $props();
</script>

{#if message}<p {id} class={["text-sm/5 text-rose-700 dark:text-rose-400", className]} role="alert">{message}</p>{/if}
