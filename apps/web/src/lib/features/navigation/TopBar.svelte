<script lang="ts">
  import type { Snippet } from "svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { useShell } from "./shell.ts";

  /** Page top bar: menu button on small screens, breadcrumb, actions on the right (T3-style, no border). */
  let { children, actions }: { children: Snippet; actions?: Snippet } = $props();
  const shell = useShell();
</script>

<div class="flex h-12 shrink-0 items-center gap-2 px-2 sm:px-4">
  <IconButton icon="bars-3" label="Open menu" class="lg:hidden" onclick={() => shell.openMenu()} />
  <nav aria-label="Breadcrumb" class="min-w-0 flex-1">
    <ol role="list" class="flex min-w-0 items-center gap-2 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400 [&>li:last-child]:text-zinc-950 dark:[&>li:last-child]:text-white">
      {@render children()}
    </ol>
  </nav>
  {#if actions}<div class="flex shrink-0 items-center gap-1">{@render actions()}</div>{/if}
</div>
