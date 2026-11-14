<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { sidebarUsageAccounts, sidebarUsageGlance } from "@canopy/domain/sidebar-usage";
  import { proxyUsageSections, proxyUsageText } from "@canopy/domain/proxy-accounts";
  import { sharedProxies } from "#lib/features/proxies/proxies.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { providerKeyOf } from "#lib/features/threads/providers.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import UsageGlance from "./UsageGlance.svelte";
  import UsageMeters from "./UsageMeters.svelte";

  let { class: className }: { class?: ClassValue } = $props();
  const overview = useOverview();
  const accounts = $derived(sidebarUsageAccounts(overview.workers, clock.now));
  const glance = $derived(sidebarUsageGlance(accounts, clock.now));

  // Accounts the gateway read from proxies in use; reading the list never calls a proxy.
  const proxies = sharedProxies();
  const sections = $derived(proxyUsageSections(proxies.data?.proxies));

  const label = $derived(
    `Show provider usage. ${[...glance.map((item) => item.label), ...sections.map(proxyUsageText)].join(". ")}`,
  );

  let open = $state(false);
  let pinned = $state(false);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => () => clearTimeout(closeTimer));

  $effect(() => {
    if (!accounts.length && !sections.length) open = false;
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
  {#if glance.length || sections.length}
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
            {#if glance.length}<UsageGlance {glance} />{:else}<Icon
                name="link"
                class="size-4 fill-zinc-500 dark:fill-zinc-400"
              />{/if}
          </button>
        {/snippet}
        <div class="grid gap-3 p-3">
          <h2 class="text-sm font-medium text-zinc-500 sm:text-xs dark:text-zinc-400">Provider usage</h2>
          {#each accounts as account (account.key)}
            {@const provider = providerKeyOf(account.provider)}
            <section class="grid min-w-0 gap-2">
              <div class="flex min-w-0 items-center gap-2">
                {#if provider}<ProviderIcon {provider} size="sm" />{/if}
                <TruncatedText class="flex-1 text-base font-medium sm:text-sm" text={account.label} />
                <TruncatedText
                  class="max-w-[40%] text-sm text-zinc-500 sm:text-xs dark:text-zinc-400"
                  text={account.computer}
                />
              </div>
              <UsageMeters usage={account.usage} now={clock.now} />
            </section>
          {/each}
          {#each sections as section (section.proxyId)}
            <a
              href={`/settings/proxies#proxy-${section.proxyId}`}
              onclick={() => (open = false)}
              class="flex min-w-0 items-center gap-2 rounded-md text-base text-zinc-700 focus-ring hover:text-zinc-950 sm:text-sm dark:text-zinc-300 dark:hover:text-white"
            >
              <Icon name="link" class="size-4 shrink-0 fill-zinc-500 dark:fill-zinc-400" />
              <TruncatedText class="flex-1" text={proxyUsageText(section)} />
            </a>
          {/each}
          <ButtonLink href="/settings/providers" variant="ghost" onclick={() => (open = false)} class="justify-start"
            >Open provider settings</ButtonLink
          >
        </div>
      </Popover>
    </div>
  {/if}
</div>
