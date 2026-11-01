<script lang="ts">
  import type { Snippet } from "svelte";

  /** Labelled group of menu items: `<MenuGroup label="Workspace">…items…</MenuGroup>`. */
  let { label, children }: { label?: string | undefined; children: Snippet } = $props();
  const id = $props.id();
</script>

<div role="group" aria-labelledby={label ? id : undefined}>
  {#if label}<div {id} class="truncate px-2.5 pt-2 pb-1 text-sm/5 font-medium text-zinc-500 sm:text-xs/4 dark:text-zinc-400">{label}</div>{/if}
  {@render children()}
</div>
