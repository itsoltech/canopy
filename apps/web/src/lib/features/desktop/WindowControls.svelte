<script lang="ts">
  import type { DesktopWindowControl } from "@canopy/ui/desktop";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  /**
   * Minimize, maximize / restore and close on Windows and Linux, where the window has no native title bar
   * (docs/desktop.md). Drawn with the palette tokens, so they follow Appearance; macOS keeps its traffic lights.
   * Headers that reach the window's right edge reserve `--window-controls-width` (routes/layout.css).
   */
  let { control }: { control: (action: DesktopWindowControl) => Promise<void> } = $props();

  let maximized = $state(false);

  $effect(() => {
    const bridge = window.canopyDesktop;

    if (!bridge) return;
    let received = false;

    const unsubscribe = bridge.onWindowState((state) => {
      received = true;
      maximized = state.maximized === true;
    });

    void bridge
      .windowState()
      .then((state) => {
        if (!received) maximized = state.maximized === true;
      })
      .catch(() => {
        /* Shell is closing. */
      });

    return unsubscribe;
  });

  const buttons = $derived<{ action: DesktopWindowControl; label: string; icon: IconName }[]>([
    { action: "minimize", label: "Minimize", icon: "minus" },
    { action: "toggle-maximize", label: maximized ? "Restore" : "Maximize", icon: maximized ? "copy" : "square" },
    { action: "close", label: "Close", icon: "x-mark" },
  ]);
</script>

<!-- After the app in the DOM and `no-drag`, so the buttons take clicks over a header's drag region. -->
<div
  class="window-controls fixed top-0 right-0 z-50 flex h-12 items-center gap-0.5 pr-2 [[data-window-fullscreen]_&]:hidden"
  role="group"
  aria-label="Window"
>
  {#each buttons as button (button.action)}
    <button
      type="button"
      class={[
        "flex size-8 items-center justify-center rounded-lg text-icon-muted focus-ring transition-colors duration-(--duration-fast) ease-smooth-out hover:text-icon-emphasis motion-reduce:transition-none",
        button.action === "close"
          ? "hover:bg-rose-600 hover:text-white active:bg-rose-700 dark:hover:bg-rose-600"
          : "hover:bg-zinc-950/5 active:bg-zinc-950/10 dark:hover:bg-white/10 dark:active:bg-white/15",
      ]}
      aria-label={button.label}
      onclick={() => void control(button.action).catch(() => undefined)}
      {@attach tooltip(button.label, { placement: "bottom" })}
    >
      <Icon name={button.icon} size={button.action === "close" ? "md" : "sm"} tone="inherit" />
    </button>
  {/each}
</div>

<style>
  .window-controls {
    -webkit-app-region: no-drag;
  }
</style>
