<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    detail,
    retryLabel,
    busy,
    error,
    retry,
    class: className,
  }: {
    detail: string;
    retryLabel: string;
    busy: boolean;
    error: string;
    retry: () => void;
    class?: ClassValue;
  } = $props();
</script>

{#if error || detail}<div
    aria-busy={busy || undefined}
    class={["grid gap-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", className]}
  >
    {#if error}<p role="alert">{error}</p>{/if}
    {#if detail}<p role="status">{detail}</p>{/if}
    <Button variant="ghost" disabled={busy} onclick={retry}>{retryLabel}</Button>
  </div>{/if}
