<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let {
    message,
    desktopActions = true,
    class: className,
  }: { message: string; desktopActions?: boolean; class?: ClassValue } = $props();
</script>

<div class={["grid h-full scroll-stable place-items-center overflow-y-auto p-6", className]}>
  <div class="grid max-w-md gap-5">
    <Alert>{message}</Alert>
    <div class="flex flex-wrap gap-3">
      {#if desktopActions && window.canopyDesktop}
        <ButtonLink href="/settings/app-updates#topic-status">Open app updates</ButtonLink>
        <Button onclick={() => window.canopyDesktop?.openSettings()}>Open desktop settings</Button>{/if}
      <Button variant="ghost" onclick={() => location.reload()}>Retry</Button>
    </div>
  </div>
</div>
