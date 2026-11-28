<script lang="ts">
  import type { ContextUsage } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import AnimatedNumber from "#lib/shared/ui/AnimatedNumber.svelte";
  import HoverCard from "#lib/shared/ui/HoverCard.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";

  let {
    mode,
    usage,
    class: className,
  }: { mode: string; usage?: ContextUsage | undefined; class?: ClassValue } = $props();

  const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  const exact = new Intl.NumberFormat("en");

  const measurement = $derived.by(() => {
    const used = usage?.usedTokens;
    const limit = usage?.limitTokens;

    if (used === undefined || limit === undefined || limit <= 0n) return undefined;

    const percent = Number((used * 100n) / limit);

    return {
      used,
      limit,
      percent,
      fill: Math.min(100, percent),
      label: `Context: ${exact.format(used)} of ${exact.format(limit)} tokens used (${percent}%).`,
    };
  });
</script>

{#if mode !== "off"}
  <!-- Keep this slot when a provider has not reported a measurement yet. -->
  <div
    class={[
      "flex shrink-0 items-center justify-center",
      mode === "text" && "min-w-28 @max-[24rem]/composer:min-w-17",
      mode === "percentage" && "min-w-12",
      mode === "bar" && "w-20 @max-[24rem]/composer:w-16",
      mode === "circle" && "w-8",
      className,
    ]}
    data-context-indicator={mode}
  >
    {#if measurement}
      <HoverCard label="Context use" placement="top-start" class="w-64">
        {#snippet trigger(props)}
          <button
            type="button"
            {...props}
            aria-label={measurement.label}
            class={[
              "relative flex h-8 w-full items-center justify-center gap-1.5 rounded-md text-xs/4 tabular-nums focus-ring hover:bg-zinc-950/5 dark:hover:bg-white/5",
              (mode === "text" || mode === "percentage") && "px-2",
              measurement.percent >= 95
                ? "text-rose-700 dark:text-rose-400"
                : measurement.percent >= 80
                  ? "text-amber-700 dark:text-amber-400"
                  : "text-zinc-500 dark:text-zinc-400",
            ]}
          >
            {#if mode === "text"}
              <span
                aria-hidden="true"
                class="flex gap-1 whitespace-nowrap @max-[24rem]/composer:flex-col @max-[24rem]/composer:gap-0 @max-[24rem]/composer:leading-3.5"
              >
                <AnimatedNumber value={compact.format(measurement.used)} updateAnimation="pop-in" />
                <span>/ <AnimatedNumber value={compact.format(measurement.limit)} updateAnimation="pop-in" /></span>
              </span>
            {:else if mode === "percentage"}
              <span aria-hidden="true"
                ><AnimatedNumber value={`${measurement.percent}%`} updateAnimation="pop-in" /></span
              >
            {:else if mode === "bar"}
              <span
                aria-hidden="true"
                class="h-1 w-9 overflow-hidden rounded-full bg-zinc-950/10 @max-[24rem]/composer:w-5 dark:bg-white/10"
              >
                <span class="block h-full rounded-full bg-current" style:width={`${measurement.fill}%`}></span>
              </span>
              <span aria-hidden="true" class="w-8 text-right">{measurement.percent}%</span>
            {:else}
              <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" class="size-5 shrink-0 -rotate-90">
                <circle cx="10" cy="10" r="7" stroke-width="2" class="stroke-zinc-950/10 dark:stroke-white/10" />
                <circle
                  cx="10"
                  cy="10"
                  r="7"
                  pathLength="100"
                  stroke-width="2"
                  class="stroke-current"
                  stroke-dasharray={`${measurement.fill} 100`}
                />
              </svg>
            {/if}
            <TouchTarget />
          </button>
        {/snippet}
        <div class="grid gap-2 text-base/6 sm:text-sm/5">
          <p class="font-medium text-zinc-900 dark:text-zinc-100">{measurement.percent}% of context used</p>
          <p class="text-zinc-600 tabular-nums dark:text-zinc-400">
            {exact.format(measurement.used)} / {exact.format(measurement.limit)} tokens
          </p>
          <p class="text-muted">Latest provider report. Your draft is not included.</p>
        </div>
      </HoverCard>
    {/if}
  </div>
{/if}
