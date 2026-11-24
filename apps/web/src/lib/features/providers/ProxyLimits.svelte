<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { usageProxyLimits } from "@canopy/domain/usage-summary";
  import type { ClassValue } from "svelte/elements";
  import ProxyAccountRow from "#lib/features/proxies/ProxyAccountRow.svelte";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import InsetList from "#lib/shared/ui/InsetList.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import TextLink from "#lib/shared/ui/TextLink.svelte";

  let { proxies, class: className }: { proxies: readonly ui.Proxy[]; class?: ClassValue } = $props();
  const groups = $derived(usageProxyLimits(proxies, clock.now));
</script>

{#if groups.length}
  <SettingsGroup title="Proxy limits" cards class={className}>
    {#each groups as { proxy, accounts } (proxy.id)}
      <div class="grid min-w-0 gap-1.5">
        <h3 class="px-1 text-base/6 sm:text-sm/6">
          <TextLink href={`/settings/proxies#proxy-${proxy.id}`} class="wrap-anywhere">{proxy.name}</TextLink>
        </h3>
        <InsetList label={`Accounts of ${proxy.name}`} class="px-3">
          {#each accounts as account (account.id)}
            <ProxyAccountRow {account} compact />
          {/each}
        </InsetList>
      </div>
    {/each}
  </SettingsGroup>
{/if}
