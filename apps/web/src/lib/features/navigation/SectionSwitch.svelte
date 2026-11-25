<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { segmentedLabel, segmentedPill, segmentedTrack } from "#lib/shared/ui/segmented.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { pop } from "#lib/shared/ui/motion.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { workingColors } from "@canopy/ui/thread-row";
  import type { ModuleId } from "@canopy/domain";
  import { sectionMemory, sectionLabels } from "./sections.svelte.ts";

  /**
   * Segmented "Threads | Bots" switch at the top of the sidebar. Each segment links to the last page
   * of its section. On an inactive segment, `counts` shows unread bot messages and `needsAttention` shows
   * an amber dot when there is no unread count. `working` counts running turns or bot executions on every segment,
   * the active one too, led by the spinner thread rows use; a narrow sidebar keeps the spinner alone. Markers
   * sit beside the label, outside its flow, so the label never moves when one appears. The raised pill slides to the active segment (sliding tabs, motion.css `t-tabs-pill`).
   */
  let {
    active,
    sections,
    needsAttention = {},
    counts = {},
    working = {},
    class: className,
  }: {
    active: ModuleId;
    sections: readonly ModuleId[];
    needsAttention?: Partial<Record<ModuleId, boolean>>;
    counts?: Partial<Record<ModuleId, number>>;
    working?: Partial<Record<ModuleId, number>>;
    class?: ClassValue;
  } = $props();

  const at = $derived(sections.indexOf(active));
  const shown = (n: number) => (n > 99 ? "99+" : String(n));
  const nouns: Record<ModuleId, [string, string]> = { threads: ["thread", "threads"], bots: ["bot", "bots"] };

  const workingLabel = (section: ModuleId, n: number) => `${n} ${nouns[section][n === 1 ? 0 : 1]} working`;
</script>

<nav aria-label="Sections" class={className}>
  <ul role="list" class={["relative grid grid-cols-2", segmentedTrack]}>
    {#if at >= 0}
      <!-- Equal columns: the pill is one column wide and moves by whole columns plus the gap. -->
      <li
        class={[
          segmentedPill,
          "t-tabs-pill w-[calc(50%-(--spacing(0.75)))] translate-x-[calc(var(--at)*(100%+(--spacing(0.5))))]",
        ]}
        style:--at={at}
        aria-hidden="true"
      ></li>
    {/if}
    {#each sections as section (section)}
      {@const current = section === active}
      {@const count = current ? 0 : (counts[section] ?? 0)}
      {@const busy = working[section] ?? 0}
      <li>
        <a
          href={sectionMemory.href(section)}
          aria-current={current ? "true" : undefined}
          data-active={current || undefined}
          class={[segmentedLabel, "sidebar-section-label desktop:cursor-default"]}
        >
          <span class="relative">
            {#if busy > 0}
              <span
                class="absolute top-0 right-full bottom-0 mr-1 flex items-center gap-0.5 text-xs/4 font-medium text-(--working-light) tabular-nums dark:text-(--working-dark)"
                style:--working-light={`var(--sidebar-working-light, ${workingColors.light.text})`}
                style:--working-dark={workingColors.dark.text}
                style:--indicator-light={workingColors.light.indicator}
                style:--indicator-dark={workingColors.dark.indicator}
                transition:pop
                {@attach tooltip(workingLabel(section, busy))}
                aria-hidden="true"
                ><Spinner
                  class="size-3.5! text-(--indicator-light) @max-[17rem]:size-3! dark:text-(--indicator-dark)"
                /><span class="@max-[17rem]:hidden">{shown(busy)}</span></span
              >
            {/if}
            {sectionLabels[section]}{#if busy > 0}<span class="sr-only">, {busy} working</span>{/if}
            <span class="absolute top-0 bottom-0 left-full ml-1.5 flex items-center">
              {#if count > 0}
                <span class="rounded-full bg-action px-1.5 text-xs/4 font-medium text-on-accent tabular-nums">
                  {shown(count)}
                </span><span class="sr-only">, {count} unread</span>
              {:else if !current && needsAttention[section]}
                <StatusDot tone="amber" /><span class="sr-only">, needs you</span>
              {/if}
            </span>
          </span>
        </a>
      </li>
    {/each}
  </ul>
</nav>
