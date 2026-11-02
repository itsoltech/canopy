<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { useShell } from "./shell.ts";
  import { SIDEBAR_HOTKEY, SIDEBAR_ID } from "./sidebar-layout.svelte.ts";

  /** Hides and shows the desktop sidebar (Mod+B anywhere); on narrow screens the menu button opens the drawer instead. */
  let { class: className }: { class?: ClassValue } = $props();
  const sidebar = useShell().sidebar;
</script>

{#if sidebar}
  <IconButton
    icon="sidebar"
    label={sidebar.collapsed ? "Show sidebar" : "Hide sidebar"}
    class={["max-lg:hidden", className]}
    aria-expanded={!sidebar.collapsed}
    aria-controls={SIDEBAR_ID}
    aria-keyshortcuts="Control+B Meta+B"
    data-sidebar-toggle
    onclick={() => sidebar.toggle()}
    tooltipOptions={{ hotkey: SIDEBAR_HOTKEY, placement: "bottom-start", region: true }}
  />
{/if}
