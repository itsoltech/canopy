<script lang="ts">
  import { dayLabel, metricValue, type UsageDay, type UsageRow, type UsageView } from "./format.ts";
  import UsagePlot from "./UsagePlot.svelte";
  import UsageProviderMark from "./UsageProviderMark.svelte";
  import { usageProviderColor } from "./providers.ts";

  let { days, providers, view }: { days: UsageDay[]; providers: UsageRow[]; view: UsageView } = $props();

  let active = $state(-1);
  const selectedIndex = $derived(active < 0 ? days.length - 1 : Math.min(active, days.length - 1));
  const selected = $derived(days[selectedIndex]);

  function navigate(event: KeyboardEvent & { currentTarget: HTMLButtonElement }, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();

    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? days.length - 1
          : Math.max(0, Math.min(days.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));

    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }

  function describe(day: UsageDay, full = false) {
    const total = `${dayLabel(day.key, full)}: ${metricValue(day.amounts, view)}${view === "tokens" ? " tokens" : ""}`;
    const parts = day.providers.map((provider) => `${provider.label}: ${metricValue(provider.amounts, view)}`);

    return [total, ...parts].join(" · ");
  }
</script>

<figure class="@container min-w-0 rounded-xl border border-divider p-4">
  <figcaption class="grid grid-cols-1 items-start gap-x-4 gap-y-1 @lg:grid-cols-2">
    <div>
      <h3 class="text-base/6 font-medium sm:text-sm/6">Daily trend</h3>
      <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Use arrow keys to explore days in UTC.</p>
    </div>
    <div class="min-h-10 text-right text-sm/5 tabular-nums">
      {#if selected}
        {@const total = `Total ${metricValue(selected.amounts, view)}${view === "tokens" ? " tokens" : ""}`}
        <p>{dayLabel(selected.key)}</p>
        <p class="truncate font-medium" title={total}>{total}</p>
      {/if}
    </div>
  </figcaption>
  <div class="relative mt-5 h-44 sm:h-52">
    <UsagePlot {days} {providers} {view} active={selectedIndex} />
    <div
      class="absolute inset-y-0 right-0 left-13 flex"
      role="group"
      aria-label={view === "cost" ? "Daily cost" : "Daily tokens"}
    >
      {#each days as day, index (day.key)}
        <button
          type="button"
          tabindex={index === selectedIndex ? 0 : -1}
          aria-label={describe(day, true)}
          title={describe(day)}
          onpointerenter={() => (active = index)}
          onfocus={() => (active = index)}
          onclick={() => (active = index)}
          onkeydown={(event) => navigate(event, index)}
          class="h-full min-w-0 flex-1 rounded-sm focus-ring focus-visible:bg-zinc-950/3 dark:focus-visible:bg-white/3"
        ></button>
      {/each}
    </div>
  </div>
  <div class="mt-2 ml-13 flex justify-between text-xs/5 text-zinc-500 dark:text-zinc-400" aria-hidden="true">
    <span>{days[0] ? dayLabel(days[0].key) : ""}</span>
    <span>{days.at(-1) ? dayLabel(days.at(-1)!.key) : ""}</span>
  </div>
  <ul class="mt-4 grid gap-x-5 gap-y-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Usage by provider on selected day">
    {#each providers as provider (provider.key)}
      {@const part = selected?.providers.find((row) => row.key === provider.key)}
      {@const value = part
        ? metricValue(part.amounts, view)
        : selected?.providers.length || selected?.amounts.reports === 0n
          ? "No usage"
          : "Unknown"}
      <li class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 text-sm/5">
        <span class="flex items-center gap-2">
          <span
            class="h-0.5 w-3 shrink-0 rounded-full"
            style:background-color={usageProviderColor(provider.key)}
            aria-hidden="true"
          ></span>
          <UsageProviderMark provider={provider.key} />
          <span>{provider.label}</span>
        </span>
        <span class="truncate text-right text-zinc-500 tabular-nums dark:text-zinc-400" title={value}>{value}</span>
      </li>
    {/each}
  </ul>
</figure>
