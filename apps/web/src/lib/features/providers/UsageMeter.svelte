<script lang="ts">
  import type { ProviderUsageWindow } from "@canopy/contracts";
  import { usagePace, usageReset, usageWindowName } from "@canopy/domain/provider-usage";
  import { usageTone } from "@canopy/domain/sidebar-usage";
  import type { ClassValue } from "svelte/elements";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  let {
    window,
    now,
    showPace = false,
    class: className,
  }: { window: ProviderUsageWindow; now: number; showPace?: boolean; class?: ClassValue } = $props();

  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const descriptionId = $props.id();
  const name = $derived(usageWindowName(window.key, window.windowMinutes));
  const left = $derived(window.reached ? 0 : window.usedPercent !== undefined ? 100 - window.usedPercent : undefined);
  const pace = $derived(showPace ? usagePace(window, now) : undefined);

  const targetLabel = $derived(pace ? `Steady-use target: ${number.format(pace.expectedLeft)}% left` : undefined);

  const tone = $derived(
    window.reached || left === 0
      ? "danger"
      : pace
        ? pace.difference < 0
          ? "warning"
          : "neutral"
        : usageTone(window.usedPercent ?? 0),
  );

  const paceLabel = $derived(
    !pace || pace.difference === 0
      ? "On pace"
      : pace.difference < 0
        ? `Ahead of pace · ${number.format(-pace.difference)} pp`
        : `Spare capacity · ${number.format(pace.difference)} pp`,
  );
</script>

<div class={["grid min-w-0 gap-1", className]}>
  <div class="flex flex-wrap justify-between gap-x-3 gap-y-0.5 tabular-nums">
    <span class="text-zinc-700 dark:text-zinc-300"
      >{name}{left !== undefined ? ` · ${number.format(left)}% left` : ""}</span
    >
    <span class="text-zinc-500 dark:text-zinc-400">{usageReset(window, true, now)}</span>
  </div>
  {#if left !== undefined}
    <div class={pace ? "py-1" : undefined}>
      <div
        role="meter"
        aria-label={`${name} limit left`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={left}
        aria-describedby={pace ? descriptionId : undefined}
        class="relative h-1 rounded-full bg-zinc-950/10 dark:bg-white/10"
      >
        <div
          class={[
            "h-full rounded-full",
            tone === "danger"
              ? "bg-rose-600 dark:bg-rose-400"
              : tone === "warning"
                ? "bg-amber-600 dark:bg-amber-400"
                : "bg-zinc-500 dark:bg-zinc-400",
          ]}
          style:width={`${left}%`}
        ></div>
        {#if pace}<div
            aria-hidden="true"
            class="absolute -top-1 h-3 w-px bg-zinc-700 dark:bg-zinc-200"
            style:left={`${pace.expectedLeft}%`}
          ></div>{/if}
      </div>
    </div>
  {/if}
  {#if pace}
    <div id={descriptionId} class="min-h-5 tabular-nums">
      <p class="sr-only">{targetLabel}</p>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -- Keyboard focus reveals the exact target on the meter. -->
      <p
        tabindex="0"
        {@attach tooltip(targetLabel)}
        class={[
          "w-fit rounded-sm whitespace-nowrap focus-ring",
          pace.difference < 0 ? "text-amber-700 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-400",
        ]}
      >
        {paceLabel}
      </p>
    </div>
  {/if}
</div>
