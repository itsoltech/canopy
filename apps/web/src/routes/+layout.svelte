<script lang="ts">
  import "./layout.css";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { isDesktopRoute, type DesktopWindowControl } from "@canopy/ui/desktop";
  import { onMount } from "svelte";
  import AppShell from "#lib/features/navigation/AppShell.svelte";
  import FileViewerHost from "#lib/features/files/FileViewerHost.svelte";
  import QuitGuardOverlay from "#lib/features/desktop/QuitGuardOverlay.svelte";
  import WindowControls from "#lib/features/desktop/WindowControls.svelte";
  import { applyWindowState } from "#lib/features/desktop/window-chrome.ts";
  import { holdFileDrops } from "#lib/features/attachments/file-intake.svelte.ts";
  import type { LayoutProps } from "./$types";

  let { children }: LayoutProps = $props();
  let lastSettings = "/settings";

  /** Windows and Linux: the window has no native buttons, the app draws them. */
  let windowControl = $state<(control: DesktopWindowControl) => Promise<void>>();

  $effect(() => {
    const path = (page.shallow?.url ?? page.url).pathname;

    if (isDesktopRoute(path)) lastSettings = path;
  });

  // A file dropped outside a drop target never replaces the app (browser tab or desktop window).
  onMount(holdFileDrops);

  onMount(() => {
    const bridge = window.canopyDesktop;

    if (!bridge?.onOpenRoute) return;

    const unsubscribe = bridge.onOpenRoute((path) => {
      if (page.url.pathname === "/desktop" || !isDesktopRoute(path)) return;

      void goto(path === "/settings" ? lastSettings : path);
    });

    if (page.url.pathname !== "/desktop") void bridge.readyForRoutes?.();

    return unsubscribe;
  });

  onMount(() => {
    document.getElementById("canopy-boot")?.remove();
    const bridge = window.canopyDesktop;

    if (!bridge) return;
    document.documentElement.dataset["canopyPlatform"] = bridge.platform;

    if ((bridge.platform === "win32" || bridge.platform === "linux") && bridge.windowControl)
      windowControl = bridge.windowControl;

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
  <FileViewerHost />
{/if}
{#if windowControl}<WindowControls control={windowControl} />{/if}
<QuitGuardOverlay />
