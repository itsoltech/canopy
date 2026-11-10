<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let {
    message,
    desktopActions = true,
    class: className,
  }: { message: string; desktopActions?: boolean; class?: ClassValue } = $props();
</script>

<div class={["grid h-full scroll-stable place-items-center overflow-y-auto p-6", className]}>
  <div class="grid max-w-md gap-5">
    <Alert title="Canopy needs your attention">{message}</Alert>
    {#if desktopActions}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Desktop settings and app updates are available on this computer.
      </p>{/if}
    <div class="flex flex-wrap gap-3">
      {#if desktopActions}<Button onclick={() => window.canopyDesktop?.openSettings()}>Open desktop settings</Button
        >{/if}
      <Button variant="ghost" onclick={() => location.reload()}>Retry</Button>
    </div>
  </div>
</div>
