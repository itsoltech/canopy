<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import ConfigSharing from "./ConfigSharing.svelte";
  import ConfigNotice from "./ConfigNotice.svelte";

  let {
    setup,
    busy,
    onshare,
    onnotice,
  }: {
    setup: ui.ComputersSnapshot;
    busy: boolean;
    onshare: (nodeId: string, enabled: boolean) => Promise<void>;
    onnotice: (id: string, action: "restore" | "dismiss") => Promise<void>;
  } = $props();

  const groupNames = $derived(setup.configGroup.filter((c) => c.nodeId !== setup.self?.nodeId).map((c) => c.name));

  const groupDescription = $derived(
    groupNames.length
      ? `Shares configuration with ${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(groupNames)}`
      : "Configuration stays on this computer.",
  );
</script>

<p role="status" class="px-1 text-base/6 text-pretty break-words text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
  {groupDescription}
</p>
{#each setup.peers.filter((peer) => !peer.viaNodeId) as computer (computer.nodeId)}
  <SettingsGroup title={computer.displayName || computer.name} class="break-anywhere">
    <ConfigSharing
      {computer}
      {busy}
      alternative={computer.configAlternativeName}
      onchange={(enabled) => onshare(computer.nodeId, enabled)}
    />
  </SettingsGroup>
{/each}
{#if setup.configNotices.length}
  <SettingsGroup title="Changed on two computers">
    {#each setup.configNotices as notice (notice.id)}
      <ConfigNotice {notice} {busy} onaction={onnotice} />
    {/each}
  </SettingsGroup>
{/if}
