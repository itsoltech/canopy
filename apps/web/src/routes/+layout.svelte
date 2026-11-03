<script lang="ts">
  import "./layout.css";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import AppShell from "#lib/features/navigation/AppShell.svelte";
  import QuitGuardOverlay from "#lib/features/desktop/QuitGuardOverlay.svelte";
  import type { LayoutProps } from "./$types";
  let { children }: LayoutProps = $props();
  onMount(() => {
    document.getElementById("canopy-boot")?.remove();
    if (window.canopyDesktop) document.documentElement.dataset["canopyPlatform"] = window.canopyDesktop.platform;
  });
</script>

{#if page.url.pathname === "/desktop"}
  {@render children()}
{:else}
  <AppShell>{@render children()}</AppShell>
{/if}
<QuitGuardOverlay />
