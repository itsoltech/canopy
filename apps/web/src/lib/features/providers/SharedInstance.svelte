<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";
  import ShareSetting from "#lib/features/computers/ShareSetting.svelte";
  import { useSharedConfig } from "#lib/features/computers/shared-config.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { instanceName, sharedInstanceKeys } from "./instances.ts";
  import SettingsSection from "./SettingsSection.svelte";

  /**
   * Sharing an instance with linked computers: its definition with the API key (stored again with each
   * computer's own key), and separately its model lists. What runs it stays per computer.
   */
  let { instance, class: className }: { instance: ui.ProviderInstance; class?: ClassValue } = $props();
  const overview = useOverview();
  const sharing = useSharedConfig();
  const keys = $derived(sharedInstanceKeys(instance));
  const shared = $derived(!instance.builtIn && sharing.shared(keys.definition));

  // Shared, but no worker of this computer runs it: the other computer has the CLI, this one does not (yet).
  const missing = $derived(
    shared && instance.workers.length > 0 && !instance.workers.some((w) => w.enabled && w.available),
  );

  const reason = $derived(instance.workers.find((w) => w.enabled && w.detail)?.detail);
</script>

{#if overview.computers.size > 0}
  <SettingsSection
    class={className}
    title="Linked computers"
    description="Shared items keep the same settings on every linked computer."
  >
    <InsetList tag="div">
      {#if !instance.builtIn}
        <ShareSetting
          itemKey={keys.definition}
          label={instanceName(instance)}
          local="Shares the name, endpoint, API key and variables; each computer stores the key encrypted with its own key. CLI paths, logins and workers stay per computer."
        />
      {/if}
      <ShareSetting
        itemKey={keys.models}
        label="Models of {instanceName(instance)}"
        local="Favourites, hidden, shown and custom models."
        disabled={!instance.builtIn && !shared && !sharing.shared(keys.models)}
        disabledReason="Share the instance first; its model lists follow it."
      />
    </InsetList>
    {#if missing}
      <Alert tone="warning" title="Not available on this computer yet">
        <p>
          This instance is shared, but no worker here can run it{reason ? `: ${reason}` : ""}. Install the CLI or turn
          the instance on for a worker on this computer.
        </p>
      </Alert>
    {/if}
  </SettingsSection>
{/if}
