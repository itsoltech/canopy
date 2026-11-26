<script lang="ts">
  import "./layout.css";
  import { page } from "$app/state";
  import { goto, beforeNavigate } from "$app/navigation";
  import { startClientDiagnostics, navigationStarted } from "#lib/features/diagnostics/client.ts";
  import { isDesktopRoute, type DesktopWindowControl } from "@canopy/ui/desktop";
  import { onMount } from "svelte";
  import { applyDesktopFocusIndicators } from "#lib/features/desktop/focus-indicators.svelte.ts";
  import { applyDeviceAppearance } from "#lib/features/settings/device-appearance.ts";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import AppShell from "#lib/features/navigation/AppShell.svelte";
  import ComposerEditMenu from "#lib/features/desktop/ComposerEditMenu.svelte";
  import QuitGuardOverlay from "#lib/features/desktop/QuitGuardOverlay.svelte";
  import WindowControls from "#lib/features/desktop/WindowControls.svelte";
  import { applyWindowState } from "#lib/features/desktop/window-chrome.ts";
  import { holdFileDrops } from "#lib/features/attachments/file-intake.svelte.ts";
  import { applyAppearance } from "#lib/features/settings/appearance.ts";
  import { appearanceState } from "#lib/features/settings/appearance-state.svelte.ts";
  import type { LayoutProps } from "./$types";

  let { children }: LayoutProps = $props();
  let lastSettings = "/settings";
  const desktopStandalone = $derived(page.url.pathname === "/desktop" || page.url.pathname === "/desktop/migration");
  const previewWindow = $derived(page.route.id === "/threads/[threadId]/preview");

  /** Windows and Linux: the window has no native buttons, the app draws them. */
  let windowControl = $state<(control: DesktopWindowControl) => Promise<void>>();

  $effect(() => {
    const path = (page.shallow?.url ?? page.url).pathname;

    if (path.startsWith("/settings") && isDesktopRoute(path)) lastSettings = path;
  });

  // A file dropped outside a drop target never replaces the app (browser tab or desktop window).
  onMount(holdFileDrops);

  onMount(startClientDiagnostics);

  onMount(() => appearanceState.connect());

  onMount(() => devicePreferences.connect());

  $effect(() => applyDeviceAppearance(devicePreferences));

  const setKeyboardNavigation = applyDesktopFocusIndicators(() => devicePreferences.values.focusIndicators);

  $effect(() => {
    if (appearanceState.connected) applyAppearance(appearanceState.values);
  });

  beforeNavigate(navigationStarted);

  onMount(() => {
    const bridge = window.canopyDesktop;

    if (!bridge?.onOpenRoute) return;

    const unsubscribe = bridge.onOpenRoute((path, keyboard) => {
      if (desktopStandalone || !isDesktopRoute(path)) return;

      if (keyboard !== undefined) setKeyboardNavigation(keyboard);
      void goto(path === "/settings" ? lastSettings : path);
    });

    return unsubscribe;
  });

  $effect(() => {
    if (!desktopStandalone) void window.canopyDesktop?.readyForRoutes?.();
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

{#if desktopStandalone || previewWindow}
  {@render children()}
{:else}
  <AppShell>{@render children()}</AppShell>
  <ComposerEditMenu />
{/if}
{#if windowControl}<WindowControls control={windowControl} />{/if}
<QuitGuardOverlay />
