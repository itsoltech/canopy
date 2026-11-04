<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { EnvironmentState } from "./environment-state.svelte.ts";
  import { PluginState } from "./plugin-state.svelte.ts";
  import MarketplaceImport from "./MarketplaceImport.svelte";
  import PluginEditor from "./PluginEditor.svelte";
  import AssignmentSummary from "./AssignmentSummary.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";

  let { environment, class: className }: { environment: EnvironmentState; class?: ClassValue } = $props();
  const state = new PluginState(untrack(() => environment));
</script>

<section
  class={["grid min-w-0 gap-5 border-t border-zinc-950/10 pt-6 dark:border-white/10", className]}
  aria-label="Marketplaces and plugins"
>
  <div class="grid gap-2">
    <h2 class="text-lg font-semibold text-balance">Marketplaces & plugins</h2>
    <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
      Keep Claude and Codex plugins in sync across your computers. Catalogs and enabled plugins stay pinned until you
      review an update.
    </p>
  </div>
  <MarketplaceImport {state} />
  {#if state.draft}<PluginEditor {state} bind:skill={state.draft} />{/if}
  <div class="grid min-w-0 divide-y divide-zinc-950/10 dark:divide-white/10">
    {#each environment.snapshot.marketplaces as market (market.id)}
      <div class="grid min-w-0 gap-3 py-4 first:pt-0 last:pb-0">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="min-w-0 font-medium wrap-anywhere">{market.name}</h3>
          <div class="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={state.busy || environment.busy}
              onclick={() => state.resolve("", "", market.id)}>Check upstream</Button
            >
            <Button
              size="sm"
              variant="ghost"
              disabled={environment.busy}
              onclick={() => state.removeMarketplace(market.id)}>Remove marketplace</Button
            >
          </div>
        </div>
        <p class="font-mono text-base wrap-anywhere sm:text-sm">
          {market.source?.url} · {market.source?.ref}<br />{market.source?.commit}
        </p>
        <Disclosure open>
          {#snippet summary()}<p class="text-base sm:text-sm">Browse {market.plugins.length} plugins</p>{/snippet}
          <div class="grid min-w-0 divide-y divide-zinc-950/10 pt-3 dark:divide-white/10">
            {#each state.catalog(market) as plugin (plugin.artifact?.name)}
              {@const installed = environment.snapshot.plugins.find(
                (p) => p.marketplaceId === market.id && p.assignment?.artifact?.name === plugin.artifact?.name,
              )}
              <div class="grid min-w-0 gap-3 py-3 first:pt-0 last:pb-0">
                <div class="flex flex-wrap items-center gap-2">
                  <p class="min-w-0 flex-1 font-medium wrap-anywhere">{plugin.artifact?.name}</p>
                  {#if installed}<Badge tone="emerald">Assigned · v{installed.assignment?.version.toString()}</Badge
                    >{/if}
                  {#if !market.plugins.some((p) => p.artifact?.name === plugin.artifact?.name)}<Badge tone="amber"
                      >Removed upstream</Badge
                    >{/if}
                  {#if installed && !plugin.unavailableReason && installed.assignment?.artifact?.checksum !== plugin.artifact?.checksum}<Badge
                      tone="amber">Update available</Badge
                    >{/if}
                </div>
                <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
                  {plugin.unavailableReason ||
                    plugin.artifact?.description ||
                    "Review this plugin's files before enabling."}
                </p>
                {#if installed?.assignment}<AssignmentSummary
                    selector={installed.assignment.selector}
                    workers={environment.snapshot.workers}
                  />{/if}
                <div class="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={(!installed && Boolean(plugin.unavailableReason)) || environment.busy}
                    onclick={() => state.edit(market, plugin)}
                    >{installed ? "Review & edit assignment" : "Review & enable"}</Button
                  >
                  {#if installed?.assignment}<Button
                      size="sm"
                      variant="ghost"
                      disabled={environment.busy}
                      onclick={() => state.removePlugin(installed.assignment!.id)}>Remove plugin</Button
                    >{/if}
                </div>
              </div>
            {/each}
          </div>
        </Disclosure>
      </div>
    {:else}<p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
        Add a marketplace to browse its plugins. Nothing runs during preview.
      </p>{/each}
  </div>
</section>
