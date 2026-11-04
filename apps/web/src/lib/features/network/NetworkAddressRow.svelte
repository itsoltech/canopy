<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { addressKind } from "./network.ts";

  /** One address phones and computers can use: the origin, how it's reached, copy; added names can be removed. */
  let {
    address,
    busy = false,
    onremove,
    class: className,
  }: { address: ui.NetworkAddress; busy?: boolean; onremove?: () => void; class?: ClassValue } = $props();

  const kind = $derived(addressKind(address.kind));
</script>

<li class={["flex items-center gap-3 px-4 py-3", className]}>
  <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
    <p class="min-w-0 font-mono text-base/6 break-all text-zinc-950 sm:text-sm/6 dark:text-white">{address.origin}</p>
    <Badge tone={kind.tone} icon={kind.icon} compact>{kind.label}</Badge>
    {#if address.interfaceName}<span class="text-sm/5 text-zinc-500 dark:text-zinc-400">{address.interfaceName}</span
      >{/if}
  </div>
  <div class="flex shrink-0 items-center gap-1">
    <CopyButton text={address.origin} label={`Copy ${address.origin}`} />
    {#if onremove}<IconButton
        icon="trash"
        label={`Remove ${address.host}`}
        size="sm"
        disabled={busy}
        onclick={onremove}
      />{/if}
  </div>
</li>
