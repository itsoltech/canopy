<script lang="ts">
  import type { Snippet } from "svelte";
  import { usePalette } from "#lib/features/commands/commands.svelte.ts";
  import { keybindings } from "#lib/features/commands/keybindings.svelte.ts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { useShell } from "./shell.ts";
  import SidebarToggle from "./SidebarToggle.svelte";

  /**
   * Page top bar: menu button on small screens (sidebar toggle on desktop), breadcrumb, actions on the right
   * (no border). The search button opens the command palette where there is no Mod+K to press
   * (narrow or touch screens). It is a macOS window title strip in every sidebar state; when the sidebar is
   * hidden, it also leaves room for the traffic lights (routes/layout.css).
   */
  let {
    children,
    actions,
    description,
    workspace,
  }: { children: Snippet; actions?: Snippet; description?: string; workspace?: Snippet } = $props();

  const descriptionId = $props.id();
  const shell = useShell();
  const palette = usePalette();
</script>

<div
  class={["flex h-12 shrink-0 items-center gap-2 px-2 sm:px-4", workspace && "bg-chrome"]}
  data-window-titlebar
  data-workspace-header={workspace ? "" : undefined}
>
  <IconButton icon="bars-3" label="Open menu" class="lg:hidden" onclick={() => shell.openMenu()} />
  <SidebarToggle />
  <nav
    aria-label="Breadcrumb"
    aria-describedby={description ? descriptionId : undefined}
    class={workspace ? "max-w-[min(14rem,22%)] min-w-12 shrink-100000" : "min-w-0 flex-1"}
  >
    <ol
      role="list"
      class="flex min-w-0 items-center gap-2 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400 [&_[aria-current=page]]:text-zinc-950 dark:[&_[aria-current=page]]:text-white"
    >
      {@render children()}
    </ol>
    {#if description}<span id={descriptionId} class="sr-only">{description}</span>{/if}
  </nav>
  {#if workspace}<div class="min-w-0 flex-1 basis-80 self-stretch pt-1.5">{@render workspace()}</div>{/if}
  {#if palette || actions}
    <div class="flex shrink-0 items-center gap-1">
      {#if palette && !workspace}
        <IconButton
          icon="magnifying-glass"
          label="Search and commands"
          aria-haspopup="dialog"
          tooltipOptions={{ hotkey: keybindings.get("command-palette")[0] }}
          class="lg:pointer-fine:hidden"
          onclick={() => palette.show()}
        />
      {/if}
      {@render actions?.()}
    </div>
  {/if}
</div>
