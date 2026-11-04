<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import ProxyForm from "./ProxyForm.svelte";

  let {
    open = $bindable(false),
    proxy,
    onsaved,
  }: { open?: boolean; proxy?: ui.Proxy | undefined; onsaved: (proxy: ui.Proxy) => void } = $props();
</script>

<Dialog
  bind:open
  title={proxy ? "Edit proxy" : "Add proxy"}
  description="One encrypted connection, reusable across provider instances."
  size="lg"
>
  {#if open}<ProxyForm
      {proxy}
      oncancel={() => (open = false)}
      onsaved={(saved) => {
        open = false;
        onsaved(saved);
      }}
    />{/if}
</Dialog>
