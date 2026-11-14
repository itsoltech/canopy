<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { sidebarUsageAccounts, sidebarUsageGlance } from "@canopy/domain/sidebar-usage";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { providerKeyOf } from "#lib/features/threads/providers.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import UsageGlance from "./UsageGlance.svelte";
  import UsageMeters from "./UsageMeters.svelte";

  let { class: className }: { class?: ClassValue } = $props();
  const overview = useOverview();
  const accounts = $derived(sidebarUsageAccounts(overview.workers, clock.now));
  const glance = $derived(sidebarUsageGlance(accounts, clock.now));
  const label = $derived(`Show provider usage. ${glance.map((item) => item.label).join(". ")}`);
  let open = $state(false);
  let pinned = $state(false);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => () => clearTimeout(closeTimer));

  $effect(() => {
    if (!accounts.length) open = false;
  });

  function hover(event: PointerEvent) {
    clearTimeout(closeTimer);

    if (event.pointerType === "mouse" && window.matchMedia("(min-width: 40rem)").matches) open = true;
  }

  function leave() {
    if (!pinned) closeTimer = setTimeout(() => (open = false), 250);
  }
</script>

<div class={["grid size-9 shrink-0 place-items-center sm:size-8", className]}>
  {#if glance.length}
    <div role="group" aria-label="Provider usage" onpointerenter={hover} onpointerleave={leave}>
      <Popover
        bind:open
        label="Provider usage"
        placement="top-start"
        sheet
        focusOnOpen={pinned}
        class="w-[min(21rem,calc(100vw-1rem))]"
        onclose={() => (pinned = false)}
      >
        {#snippet trigger(props)}
          <button
            {...props}
            type="button"
            aria-label={label}
            class="grid size-9 place-items-center rounded-lg focus-ring hover:bg-zinc-950/5 sm:size-8 dark:hover:bg-white/5"
            onclick={() => {
              open = !pinned;
              pinned = open;
            }}
          >
            <UsageGlance {glance} />
          </button>
        {/snippet}
        <div class="grid gap-3 p-3">
          <h2 class="text-sm font-medium text-zinc-500 sm:text-xs dark:text-zinc-400">Provider usage</h2>
          {#each accounts as account (account.key)}
            {@const provider = providerKeyOf(account.provider)}
            <section class="grid min-w-0 gap-2">
              <div class="flex min-w-0 items-center gap-2">
                {#if provider}<ProviderIcon {provider} size="sm" />{/if}
                <span class="min-w-0 flex-1 truncate text-base font-medium sm:text-sm" title={account.label}
                  >{account.label}</span
                >
                <span
                  class="max-w-[40%] truncate text-sm text-zinc-500 sm:text-xs dark:text-zinc-400"
                  title={account.computer}>{account.computer}</span
                >
              </div>
              <UsageMeters usage={account.usage} now={clock.now} />
            </section>
          {/each}
          <a
            href="/settings/providers"
            onclick={() => (open = false)}
            class="flex min-h-10 items-center rounded-md px-2 text-base text-brand-700 focus-ring hover:bg-zinc-950/5 sm:min-h-7 sm:text-sm dark:text-brand-400 dark:hover:bg-white/5"
            >Open provider settings</a
          >
        </div>
      </Popover>
    </div>
  {/if}
</div>
