<script lang="ts">
  import type { DesktopMigrationStatus } from "@canopy/ui/desktop";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ChoiceControl from "#lib/shared/ui/ChoiceControl.svelte";

  type Peer = NonNullable<NonNullable<DesktopMigrationStatus["preparation"]>["peers"]>[number];

  let {
    peers,
    selected = $bindable([]),
    view,
  }: { peers: readonly Peer[]; selected?: readonly string[]; view: "plan" | "affected" | "follow-up" } = $props();

  const selectedIds = $derived(new Set(selected));
  const selectedPeers = $derived(peers.filter((peer) => selectedIds.has(peer.nodeId)));
  const visiblePeers = $derived(view === "follow-up" ? selectedPeers : peers);

  function toggle(nodeId: string, checked: boolean) {
    selected = checked ? [...selected, nodeId] : selected.filter((id) => id !== nodeId);
  }
</script>

{#if visiblePeers.length}
  <section class="grid min-w-0 gap-3" aria-labelledby="migration-peers">
    <div class="grid gap-1">
      <h2 class="text-lg/7 font-semibold" id="migration-peers">
        {view === "follow-up" ? "Computers to follow up with" : "Linked computers"}
      </h2>
      {#if view === "follow-up"}
        <p class="text-pretty text-muted">
          Share the server’s SSH address with each owner. On their own Desktop, they can open Settings → Desktop →
          Migrate gateway, choose “Join a shared server”, and confirm their import. Offline computers can join later.
        </p>
      {:else}
        <p class="text-pretty text-muted">Links to this computer’s gateway stop after the switch.</p>
        {#if view === "plan"}
          <p class="text-pretty text-muted">
            Choose any linked computers you want to follow up with. Each owner must confirm the import on their own
            Desktop.
          </p>
        {/if}
      {/if}
    </div>
    {#if view === "plan"}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p role="status" class="font-medium">
          {selectedPeers.length
            ? `${selectedPeers.length.toLocaleString()} selected for follow-up`
            : "This computer only"}
        </p>
        <div class="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedPeers.length === peers.length}
            onclick={() => (selected = peers.map(({ nodeId }) => nodeId))}>Select all</Button
          >
          <Button size="sm" variant="ghost" disabled={!selectedPeers.length} onclick={() => (selected = [])}
            >Clear selection</Button
          >
        </div>
      </div>
    {/if}
    <ul
      class="max-h-72 scroll-stable divide-y divide-divider overflow-y-auto rounded-xl bg-surface ring-1 ring-divider"
    >
      {#each visiblePeers as { nodeId, name, online } (nodeId)}
        <li class="px-3 py-2">
          <div class="flex min-h-8 gap-3">
            {#if view === "plan"}
              <label class="flex min-w-0 flex-1 items-center gap-3 wrap-anywhere pointer-coarse:min-h-11">
                <ChoiceControl
                  checked={selectedIds.has(nodeId)}
                  onchange={(event) => toggle(nodeId, event.currentTarget.checked)}
                />
                {name}
              </label>
            {:else}
              <span class="min-w-0 flex-1 self-center wrap-anywhere">{name}</span>
            {/if}
            <div class="self-center">
              <Badge tone={online ? "emerald" : "neutral"}>{online ? "Online at trial" : "Offline at trial"}</Badge>
            </div>
          </div>
        </li>
      {/each}
    </ul>
    {#if view === "plan" && peers.some(({ online }) => !online)}
      <p class="text-muted">Offline computers can join later.</p>
    {/if}
  </section>
{/if}
