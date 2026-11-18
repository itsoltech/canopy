<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { sidebarUsageAccounts } from "@canopy/domain/sidebar-usage";
  import { usageSummary, usageSummaryGlance, usageSummaryNotes } from "@canopy/domain/usage-summary";
  import { sharedProxies } from "#lib/features/proxies/proxies.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import TextLink from "#lib/shared/ui/TextLink.svelte";
  import UsageGlance from "./UsageGlance.svelte";
  import UsageSummaryRow from "./UsageSummaryRow.svelte";
  import type { FooterPopover } from "#lib/features/navigation/footer-popovers.svelte.ts";

  let { panel, class: className }: { panel: FooterPopover; class?: ClassValue } = $props();
  const overview = useOverview();
  const accounts = $derived(sidebarUsageAccounts(overview.workers, clock.now));

  // Accounts the gateway read from proxies in use; reading the list never calls a proxy.
  const proxies = sharedProxies();
  const rows = $derived(usageSummary(accounts, proxies.data?.proxies ?? [], clock.now));
  const glance = $derived(usageSummaryGlance(rows, clock.now));
  const notes = $derived(usageSummaryNotes(proxies.data?.proxies ?? []));

  const usageProxies = $derived(
    (proxies.data?.proxies ?? []).filter((proxy) => proxy.kind === "cliproxyapi" && proxy.usedBy.length),
  );

  const label = $derived(
    `Show provider usage. ${[...glance.map((item) => `${item.label}.`), ...notes.map((note) => note.text)].join(" ")}`,
  );

  $effect(() => {
    if (!glance.length && !usageProxies.length) panel.close();
  });
</script>

<div class={["grid h-9 w-14 shrink-0 place-items-center sm:h-8 sm:w-13", className]}>
  {#if glance.length || usageProxies.length}
    <div role="group" aria-label="Provider usage" onpointerenter={panel.enter} onpointerleave={panel.leave}>
      <Popover
        bind:open={panel.isOpen, panel.setOpen}
        label="Provider usage"
        placement="top-start"
        sheet
        focusOnOpen={panel.pinned}
        class={["w-[min(21rem,calc(100vw-1rem))]", panel.superseded && "sidebar-footer-popover-superseded"]}
      >
        {#snippet trigger(props)}
          <button
            {...props}
            type="button"
            aria-label={label}
            class="grid h-9 w-14 place-items-center rounded-lg focus-ring hover:bg-zinc-950/5 sm:h-8 sm:w-13 dark:hover:bg-white/5"
            onclick={panel.press}
          >
            {#if glance.length}<UsageGlance {glance} />{:else}<Icon
                name="link"
                class="size-4 fill-zinc-500 dark:fill-zinc-400"
              />{/if}
          </button>
        {/snippet}
        <div class="grid gap-3 p-3">
          <h2 class="text-sm font-medium text-zinc-500 sm:text-xs dark:text-zinc-400">Provider usage</h2>
          <div class="grid max-h-[min(24rem,50dvh)] min-w-0 gap-3 overflow-y-auto overscroll-contain">
            {#if rows.length}
              <ul role="list" class="grid min-w-0 gap-3">
                {#each rows as row (row.provider)}<UsageSummaryRow {row} />{/each}
              </ul>
            {:else if !notes.length}
              <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">No limit readings yet.</p>
            {/if}
            {#each notes as note (note.proxyId)}
              <p
                role={note.checking ? "status" : undefined}
                class="text-sm/5 text-pretty text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
              >
                {note.text}
                {#if !note.checking}<TextLink href={`/settings/proxies#proxy-${note.proxyId}`} onclick={panel.close}
                    >Check proxy settings</TextLink
                  >{/if}
              </p>
            {/each}
          </div>
          <ButtonLink href="/settings/providers" variant="ghost" onclick={panel.close} class="justify-start"
            >Open provider settings</ButtonLink
          >
        </div>
      </Popover>
    </div>
  {/if}
</div>
