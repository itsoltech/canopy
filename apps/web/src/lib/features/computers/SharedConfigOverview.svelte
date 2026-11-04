<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { changedLine, localCopyNote } from "./computers.ts";
  import ConflictDialog from "./ConflictDialog.svelte";
  import ShareScope from "./ShareScope.svelte";
  import { useSharedConfig } from "./shared-config.svelte.ts";

  /** Settings → Linked computers: open questions first, then everything shared and the copies that became local. */
  let { class: className }: { class?: ClassValue } = $props();
  const overview = useOverview();
  const shared = useSharedConfig();
  const name = (nodeId: string) => overview.machine(nodeId);

  const items = $derived(
    shared.snapshot.items.toSorted((a, b) => Number(b.shared) - Number(a.shared) || a.label.localeCompare(b.label)),
  );

  let reviewing = $state<ui.SharedConfigConflict>();
  let open = $state(false);
</script>

<div class={["settings-stack", className]}>
  {#if shared.snapshot.conflicts.length}
    <SettingsGroup
      title="Needs your decision"
      description="These items differ between two computers: both changed while apart, or each had its own when sharing started. Each keeps its version until you choose."
    >
      {#each shared.snapshot.conflicts as conflict (`${conflict.key}:${conflict.nodeId}`)}
        <SettingsRow
          title={conflict.label}
          description={`This computer and ${name(conflict.nodeId) ?? "another computer"} · ${conflict.fields.map((f) => f.name).join(", ") || "changed"}`}
        >
          {#snippet control()}<Button
              size="sm"
              onclick={() => {
                reviewing = conflict;
                open = true;
              }}>Choose a version</Button
            >{/snippet}
        </SettingsRow>
      {/each}
    </SettingsGroup>
  {/if}
  <SettingsGroup
    title="Shared configuration"
    description="Turn on “Share with linked computers” next to a provider, model list, setting or project. CLI paths, logins, workspaces, addresses, desktop settings and connector accounts stay on each computer."
  >
    {#each items as item (item.key)}
      <SettingsRow title={item.label} description={item.shared ? changedLine(item, name) : localCopyNote(item, name)}>
        {#snippet control()}<ShareScope itemKey={item.key} />{/snippet}
      </SettingsRow>
    {:else}
      <SettingsRow
        title="Nothing shared yet"
        description="Every setting applies only to the computer where you change it."
      />
    {/each}
  </SettingsGroup>
</div>
{#if reviewing}<ConflictDialog conflict={reviewing} bind:open />{/if}
