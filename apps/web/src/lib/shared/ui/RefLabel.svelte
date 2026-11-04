<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** Keep the branch's distinguishing suffix visible while the prefix can ellipsize with available space. */
  let { value, class: className }: { value: string; class?: ClassValue } = $props();
  const split = $derived(value.length > 28);
</script>

<span class={["flex max-w-full min-w-0 font-mono whitespace-nowrap", className]} title={value} aria-label={value}>
  {#if split}
    <span class="min-w-0 truncate">{value.slice(0, -9)}</span><span class="max-w-full shrink-0 truncate [direction:rtl]"
      ><bdi dir="ltr">{value.slice(-9)}</bdi></span
    >
  {:else}
    <span class="truncate">{value}</span>
  {/if}
</span>
