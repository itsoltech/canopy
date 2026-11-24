<script lang="ts">
  import { onMount, untrack } from "svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { rise } from "#lib/shared/ui/motion.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { whatsNew as notes } from "./whats-new.svelte.ts";
  import WhatsNewDialog from "./WhatsNewDialog.svelte";

  const capabilities = useGatewayCapabilities();
  let desktop = $state<boolean>();

  onMount(() => {
    desktop = Boolean(window.canopyDesktop);
    const bridge = window.canopyDesktop;
    let active = true;

    if (bridge?.appUpdateHistory)
      void bridge
        .appUpdateHistory()
        .then((history) => {
          if (active) notes.receive(history);
        })
        .catch(() => {});
    else if (bridge)
      void bridge
        .updates()
        .then((status) => {
          if (active) notes.receive({ version: status.version, from: "", updated: false });
        })
        .catch(() => {});

    return () => {
      active = false;
    };
  });

  $effect(() => {
    const scope = capabilities?.clientPreferencesScope;

    if (desktop === false && scope) untrack(() => notes.connectWeb(scope));
  });
</script>

{#if notes.notice}
  <aside
    class="pointer-events-none z-40 flex shrink-0 justify-end bg-surface pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] xl:fixed xl:inset-x-0 xl:bottom-0 xl:bg-transparent"
    aria-label="App updated"
  >
    <div
      transition:rise
      class="pointer-events-auto flex max-w-sm min-w-0 items-start gap-3 rounded-lg border border-divider bg-surface py-1.5 pr-2 pl-3.5 shadow-sm dark:shadow-none pointer-coarse:py-2"
    >
      <div class="flex min-w-0 flex-wrap items-center gap-x-3">
        <p class="min-w-0 text-sm/5 wrap-anywhere text-muted" role="status">
          Updated to <span class="inline-block max-w-full align-bottom font-medium text-ink tabular-nums"
            >{notes.current}</span
          >
        </p>
        <Button
          variant="text"
          size="sm"
          class="underline decoration-current/35 underline-offset-2 hover:decoration-current"
          aria-haspopup="dialog"
          onclick={() => notes.show()}>View changes</Button
        >
      </div>
      <IconButton icon="x-mark" label="Dismiss update notice" size="sm" onclick={() => (notes.notice = false)} />
    </div>
  </aside>
{/if}
<WhatsNewDialog />
