<script lang="ts">
  import { tick } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { sidebarUsageAccounts } from "@canopy/domain/sidebar-usage";
  import { usageSummary, usageSummaryGlance, usageSummaryNotes } from "@canopy/domain/usage-summary";
  import { sharedProxies } from "#lib/features/proxies/proxies.ts";
  import { focusables } from "#lib/shared/ui/floating.ts";
  import { longPress } from "#lib/shared/ui/long-press.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import SidebarFooterPopover from "#lib/features/navigation/SidebarFooterPopover.svelte";
  import TextLink from "#lib/shared/ui/TextLink.svelte";
  import UsageGlance from "./UsageGlance.svelte";
  import UsageSummaryRow from "./UsageSummaryRow.svelte";
  import type { FooterPopover } from "#lib/features/navigation/footer-popovers.svelte.ts";

  let { panel, class: className }: { panel: FooterPopover; class?: ClassValue } = $props();
  let content = $state<HTMLDivElement>();
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
    `Open provider settings. ${[...glance.map((item) => `${item.label}.`), ...notes.map((note) => note.text)].join(" ")}`,
  );

  async function openPreview(event: KeyboardEvent) {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    panel.setOpen(true);
    await tick();

    if (content) focusables(content)[0]?.focus();
  }
</script>

<div class={["grid h-9 w-14 shrink-0 place-items-center sm:h-8 sm:w-13", className]}>
  {#if glance.length || usageProxies.length}
    <SidebarFooterPopover {panel} label="Provider limits" panelClass="w-[min(21rem,calc(100vw-1rem))]">
      {#snippet trigger(props)}
        <a
          {...props}
          href="/settings/providers"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={panel.isOpen()}
          aria-keyshortcuts="ArrowDown"
          onkeydown={openPreview}
          {@attach longPress(() => panel.setOpen(true))}
          class="grid h-9 w-14 place-items-center rounded-lg focus-ring hover:bg-zinc-950/5 sm:h-8 sm:w-13 dark:hover:bg-white/5 desktop:cursor-default"
        >
          {#if glance.length}<UsageGlance {glance} />{:else}<Icon
              name="link"
              class="size-4 fill-zinc-500 dark:fill-zinc-400"
            />{/if}
        </a>
      {/snippet}
      <div bind:this={content} class="grid gap-3 p-3">
        <h2 class="text-sm font-medium text-zinc-500 sm:text-xs dark:text-zinc-400">Provider limits</h2>
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
      </div>
    </SidebarFooterPopover>
  {/if}
</div>
