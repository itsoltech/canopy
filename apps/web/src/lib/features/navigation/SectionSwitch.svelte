<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { segmentedLabel, segmentedPill, segmentedTrack } from "#lib/shared/ui/segmented.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import type { ModuleId } from "@canopy/domain";
  import { sectionMemory, sectionLabels } from "./sections.svelte.ts";

  /**
   * Segmented "Threads | Bots" switch at the top of the sidebar. Each segment links to the last page
   * of its section; `attention` puts a dot on a segment you are not in: amber when something there needs
   * you, emerald when something there finished and you have not seen it. `counts` shows a number instead (unread
   * bot messages). Markers sit beside the label, outside its flow, so the label never moves when one appears.
   * The raised pill slides to the active segment (sliding tabs, motion.css `t-tabs-pill`).
   */
  let {
    active,
    sections,
    attention = {},
    counts = {},
    class: className,
  }: {
    active: ModuleId;
    sections: readonly ModuleId[];
    attention?: Partial<Record<ModuleId, "needs" | "unseen" | undefined>>;
    counts?: Partial<Record<ModuleId, number>>;
    class?: ClassValue;
  } = $props();

  const at = $derived(sections.indexOf(active));
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
      {@const dot = !current && !count && attention[section]}
      <li>
        <a
          href={sectionMemory.href(section)}
          aria-current={current ? "true" : undefined}
          data-active={current || undefined}
          class={[segmentedLabel, "sidebar-section-label"]}
        >
          <span class="relative">
            {sectionLabels[section]}
            <span class="absolute top-0 bottom-0 left-full ml-1.5 flex items-center">
              {#if count > 0}
                <span class="rounded-full bg-action px-1.5 text-xs/4 font-medium text-on-accent tabular-nums">
                  {count > 99 ? "99+" : count}
                </span><span class="sr-only">, {count} unread</span>
              {:else if dot === "needs"}
                <StatusDot tone="amber" /><span class="sr-only">, needs you</span>
              {:else if dot === "unseen"}
                <StatusDot tone="emerald" /><span class="sr-only">, new results</span>
              {/if}
            </span>
          </span>
        </a>
      </li>
    {/each}
  </ul>
</nav>
