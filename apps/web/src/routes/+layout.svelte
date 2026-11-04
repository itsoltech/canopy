<script lang="ts">
  import "./layout.css";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import AppShell from "#lib/features/navigation/AppShell.svelte";
  import QuitGuardOverlay from "#lib/features/desktop/QuitGuardOverlay.svelte";
  import { applyWindowState } from "#lib/features/desktop/window-chrome.ts";
  import type { LayoutProps } from "./$types";

  let { children }: LayoutProps = $props();

  onMount(() => {
    document.getElementById("canopy-boot")?.remove();
    const bridge = window.canopyDesktop;

    if (!bridge) return;
    document.documentElement.dataset["canopyPlatform"] = bridge.platform;

    // Feature detection also supports a remote web build running in an older desktop shell.
    if (!bridge.windowState || !bridge.onWindowState) return;
    let received = false;

    const unsubscribe = bridge.onWindowState((state) => {
      received = true;
      applyWindowState(state);
    });

    void bridge
      .windowState()
      .then((state) => {
        if (!received) applyWindowState(state);
      })
      .catch(() => {
        /* Shell is closing. */
      });

    return unsubscribe;
  });
</script>

{#if page.url.pathname === "/desktop"}
  {@render children()}
{:else}
  <AppShell>{@render children()}</AppShell>
{/if}
<QuitGuardOverlay />
