<script lang="ts">
  import type { Snippet } from "svelte";
  import { PALETTE_HOTKEY, usePalette } from "#lib/features/commands/commands.svelte.ts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { useShell } from "./shell.ts";
  import SidebarToggle from "./SidebarToggle.svelte";

  /**
   * Page top bar: menu button on small screens (sidebar toggle on desktop), breadcrumb, actions on the right
   * (T3-style, no border). The search button opens the command palette where there is no Mod+K to press
   * (narrow or touch screens). While the sidebar is hidden it is the macOS window's title strip, clear of the
   * traffic lights (routes/layout.css).
   */
  let { children, actions }: { children: Snippet; actions?: Snippet } = $props();
  const shell = useShell();
  const palette = usePalette();
</script>

<div class="flex h-12 shrink-0 items-center gap-2 px-2 sm:px-4" data-window-titlebar>
  <IconButton icon="bars-3" label="Open menu" class="lg:hidden" onclick={() => shell.openMenu()} />
  <SidebarToggle />
  <nav aria-label="Breadcrumb" class="min-w-0 flex-1">
    <ol role="list" class="flex min-w-0 items-center gap-2 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400 [&>li:last-child]:text-zinc-950 dark:[&>li:last-child]:text-white">
      {@render children()}
    </ol>
  </nav>
  {#if palette || actions}
    <div class="flex shrink-0 items-center gap-1">
      {#if palette}
        <IconButton icon="magnifying-glass" label="Search and commands" aria-haspopup="dialog" tooltipOptions={{ hotkey: PALETTE_HOTKEY }} class="lg:pointer-fine:hidden" onclick={() => palette.show()} />
      {/if}
      {@render actions?.()}
    </div>
  {/if}
</div>
