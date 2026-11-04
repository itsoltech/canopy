<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ShareOnwardChoice from "./ShareOnwardChoice.svelte";

  /** A partner's immediate opt-in selection. Indirect computers are never candidates. */
  let { open = $bindable(false), computer, peers, busy = false, error = "", onchange, class: className }: {
    open?: boolean; computer: ui.LinkedComputer | undefined; peers: ui.LinkedComputer[];
    busy?: boolean; error?: string; onchange: (nodeIds: string[]) => void; class?: ClassValue;
  } = $props();
  const candidates = $derived(peers.filter((p) => p.nodeId !== computer?.nodeId && !p.viaNodeId));
  const name = $derived(computer?.displayName || computer?.name || "this computer");
  function toggle(nodeId: string, enabled: boolean) {
    const selected = new Set(computer?.shareOnwardNodeIds ?? []);
    if (enabled) selected.add(nodeId); else selected.delete(nodeId);
    onchange([...selected]);
  }
</script>

<Dialog bind:open class={className} title={`Share onward with ${name}`} description={`Choose which of your other computers ${name} can access through this computer. Nothing is shared by default.`}>
  <div class="grid min-w-0 gap-4">
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Changes apply immediately. Turning a computer off removes access and its synced history from {name}. Shared settings and credentials stay between directly linked computers.</p>
    <div class="divide-y divide-zinc-950/5 dark:divide-white/10">
      {#each candidates as peer (peer.nodeId)}
        {#if computer}<ShareOnwardChoice {peer} recipient={computer} {busy} onchange={(enabled) => toggle(peer.nodeId, enabled)} />{/if}
      {:else}
        <p class="py-3 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Link another computer here to share it onward.</p>
      {/each}
    </div>
    {#if busy}<p role="status" class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Saving sharing choices…</p>{/if}
  </div>
</Dialog>
