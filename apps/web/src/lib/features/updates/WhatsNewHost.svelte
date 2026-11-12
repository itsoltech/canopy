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
    class="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-end px-4"
    aria-label="App updated"
    data-window-no-drag
  >
    <div
      transition:rise
      class="pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-xl border border-divider bg-surface p-3 shadow-lg dark:shadow-none"
    >
      <div class="grid min-w-0 flex-1 gap-2">
        <p class="break-anywhere text-sm/5 font-medium tabular-nums" role="status">Updated to {notes.current}</p>
        <div><Button size="sm" onclick={() => notes.show()}>See what's new</Button></div>
      </div>
      <IconButton icon="x-mark" label="Dismiss update notice" size="sm" onclick={() => (notes.notice = false)} />
    </div>
  </aside>
{/if}
<WhatsNewDialog />
