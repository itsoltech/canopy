<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { storageComponents, storageHelp, storageTotalsHelp } from "@canopy/domain/diagnostics";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";
  import StorageComponent from "./StorageComponent.svelte";

  let { snapshot }: { snapshot: ui.DiagnosticsSnapshot } = $props();
</script>

{#if snapshot.computers.length || snapshot.desktopStorage}
  <SettingsGroup title="Canopy storage" description={storageHelp} cards>
    <p class="px-1 text-sm text-muted">{storageTotalsHelp}</p>
    {#each snapshot.computers as computer (computer.computerId)}
      <SettingsCard>
        <h3 class="border-b border-zinc-950/5 px-4 py-3 font-medium wrap-anywhere dark:border-white/8">
          {computer.name}
        </h3>
        <div class="divide-y divide-zinc-950/5 dark:divide-white/8">
          {#each storageComponents(computer) as component (component.id)}
            <StorageComponent {component} />
          {/each}
        </div>
      </SettingsCard>
    {/each}
    {#if snapshot.desktopStorage}
      <SettingsCard>
        <StorageComponent
          component={{
            id: "desktop",
            name: "This desktop",
            kind: "",
            state: "online",
            storage: snapshot.desktopStorage,
            ageUncertain: false,
          }}
        />
      </SettingsCard>
    {/if}
  </SettingsGroup>
{/if}
