<script lang="ts">
  import type { ProxyCapacityGroup } from "@canopy/domain/proxy-capacity";
  import { usageReset, usageWindowName } from "@canopy/domain/provider-usage";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";

  let { group }: { group: ProxyCapacityGroup } = $props();
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
</script>

<div class="grid min-w-0 gap-2 text-sm/5 sm:text-xs/5">
  <div class="flex min-w-0 items-center gap-2">
    <ProviderIcon provider={group.mark} size="sm" />
    <span class="min-w-0 flex-1 truncate text-base font-medium sm:text-sm">{group.name}</span>
    <span class="shrink-0 text-zinc-500 dark:text-zinc-400"
      >{group.accounts.length} {group.accounts.length === 1 ? "account" : "accounts"}</span
    >
  </div>
  {#each group.windows as window (`${window.key}:${window.windowMinutes}`)}
    <div class="grid min-w-0 gap-1 tabular-nums">
      <div class="flex min-w-0 justify-between gap-2">
        <span class="min-w-0 truncate text-zinc-700 dark:text-zinc-300"
          >{usageWindowName(window.key, window.windowMinutes)}</span
        >
        <span
          class={[
            "shrink-0",
            window.percentLeft <= 10
              ? "text-rose-600 dark:text-rose-400"
              : window.percentLeft <= 30
                ? "text-amber-700 dark:text-amber-400"
                : "text-zinc-700 dark:text-zinc-300",
          ]}>{number.format(window.percentLeft)}% left</span
        >
      </div>
      <div
        role="meter"
        aria-label={`${group.name} ${usageWindowName(window.key, window.windowMinutes)} capacity left`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.percentLeft}
        class="h-1 overflow-hidden rounded-full bg-zinc-950/10 dark:bg-white/10"
      >
        <div
          class={[
            "h-full rounded-full",
            window.percentLeft <= 10
              ? "bg-rose-600 dark:bg-rose-400"
              : window.percentLeft <= 30
                ? "bg-amber-600 dark:bg-amber-400"
                : "bg-zinc-500 dark:bg-zinc-400",
          ]}
          style:width={`${window.percentLeft}%`}
        ></div>
      </div>
      <div class="flex flex-wrap justify-between gap-x-2 text-zinc-500 dark:text-zinc-400">
        <span>{number.format(window.remaining)} of {number.format(window.total)} units left</span>
        <span>{usageReset(window, true, clock.now)}</span>
      </div>
      {#if window.percentLeft <= 10}<p class="text-rose-600 dark:text-rose-400">Low capacity</p>{/if}
      {#if window.reporting < group.accounts.length}<p class="text-zinc-500 dark:text-zinc-400">
          {window.reporting} of {group.accounts.length} accounts reporting
        </p>{/if}
      {#if window.unknown}<p class="text-zinc-500 dark:text-zinc-400">
          {window.unknown}
          {window.unknown === 1 ? "unknown plan" : "unknown plans"} counted as ×1
        </p>{/if}
    </div>
  {:else}
    <p class="min-h-5 text-zinc-500 dark:text-zinc-400">No current limit readings.</p>
  {/each}
  {#if group.excluded}<p class="text-zinc-500 dark:text-zinc-400">
      {group.excluded} unavailable {group.excluded === 1 ? "account" : "accounts"} excluded
    </p>{/if}
</div>
