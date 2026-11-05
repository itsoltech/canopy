<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import type { EnvironmentState } from "./environment-state.svelte.ts";
  import { PluginState } from "./plugin-state.svelte.ts";
  import MarketplaceImport from "./MarketplaceImport.svelte";
  import MarketplacePlugins from "./MarketplacePlugins.svelte";
  import PluginEditor from "./PluginEditor.svelte";
  import LibraryRow from "./LibraryRow.svelte";
  import { librarySource } from "./library-meta.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";

  let { environment, class: className }: { environment: EnvironmentState; class?: ClassValue } = $props();
  const controller = new PluginState(untrack(() => environment));
  let marketOpen = $state(false);
  let marketStep = $state(0);

  function add() {
    controller.preview = undefined;
    controller.error = "";
    environment.error = "";
    marketStep = 0;
    marketOpen = true;
  }

  function review(market: ui.EnvironmentMarketplace) {
    marketStep = 1;
    marketOpen = true;
    environment.error = "";
    void controller.resolve("", "", market.id);
  }
</script>

<section class={["grid min-w-0 gap-3 border-t border-divider pt-4", className]} aria-label="Marketplaces and plugins">
  <div class="grid gap-2">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-lg font-semibold text-balance">Marketplaces & plugins</h2>
      <Button size="sm" onclick={add}>Add marketplace or plugin</Button>
    </div>
    <p class="text-base text-pretty text-muted sm:text-sm">
      Keep Claude and Codex plugins in sync across your computers. Catalogs and enabled plugins stay pinned until you
      review an update.
    </p>
  </div>
  <MarketplaceImport state={controller} bind:open={marketOpen} bind:step={marketStep} />
  <PluginEditor state={controller} bind:skill={controller.draft} />
  <div class="grid min-w-0 divide-y divide-divider">
    {#each environment.snapshot.marketplaces as market (market.id)}
      <div class="grid min-w-0">
        <LibraryRow
          id={market.id}
          name={market.name}
          meta={`${market.plugins.length} ${market.plugins.length === 1 ? "plugin" : "plugins"} · ${librarySource(market.source?.url)} · ${market.source?.ref ?? ""} · ${market.source?.commit.slice(0, 12) ?? ""}`}
          disabled={controller.busy || environment.busy}
          editLabel="Review marketplace"
          removeLabel="Remove marketplace"
          onedit={() => review(market)}
          onremove={() => void controller.removeMarketplace(market.id)}
        >
          {#snippet status()}<Badge compact>Pinned catalog</Badge>{/snippet}
          {#snippet actions()}<IconButton
              icon="arrow-path"
              label="Check upstream"
              size="sm"
              disabled={controller.busy || environment.busy}
              onclick={() => review(market)}
            />{/snippet}
        </LibraryRow>
        <MarketplacePlugins {controller} {market} class="ml-3 border-l border-divider pl-3" />
      </div>
    {:else}<div class="grid gap-3 rounded-xl bg-zinc-950/3 p-5 dark:bg-white/4">
        <p class="text-base text-pretty text-muted sm:text-sm">
          Add a marketplace to browse its plugins. Nothing runs during preview.
        </p>
        <div><Button onclick={add}>Add your first marketplace</Button></div>
      </div>{/each}
  </div>
</section>
