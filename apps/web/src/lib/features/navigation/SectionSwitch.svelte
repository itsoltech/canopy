<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { segmentedLabel, segmentedPill, segmentedTrack } from "#lib/shared/ui/segmented.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { sectionMemory, sections, type Section } from "./sections.svelte.ts";

  /**
   * Segmented "Threads | Bots" switch at the top of the sidebar. Each segment links to the last page
   * of its section; `attention` puts a dot on a segment you are not in: amber when something there needs
   * you, emerald when something there finished and you have not seen it. The raised pill slides to the
   * active segment (sliding tabs, motion.css `t-tabs-pill`).
   */
  let {
    active,
    attention = {},
    class: className,
  }: { active: Section; attention?: Partial<Record<Section, "needs" | "unseen" | undefined>>; class?: ClassValue } = $props();
  const at = $derived(sections.findIndex((section) => section.id === active));
</script>

<nav aria-label="Sections" class={className}>
  <ul role="list" class={["relative grid grid-cols-2", segmentedTrack]}>
    {#if at >= 0}
      <!-- Equal columns: the pill is one column wide and moves by whole columns plus the gap. -->
      <li class={[segmentedPill, "t-tabs-pill w-[calc(50%-(--spacing(0.75)))] translate-x-[calc(var(--at)*(100%+(--spacing(0.5))))]"]} style:--at={at} aria-hidden="true"></li>
    {/if}
    {#each sections as section (section.id)}
      {@const current = section.id === active}
      {@const dot = !current && attention[section.id]}
      <li>
        <a href={sectionMemory.href(section.id)} aria-current={current ? "true" : undefined} data-active={current || undefined} class={segmentedLabel}>
          {section.label}
          {#if dot === "needs"}
            <StatusDot tone="amber" /><span class="sr-only">, needs you</span>
          {:else if dot === "unseen"}
            <StatusDot tone="emerald" /><span class="sr-only">, new results</span>
          {/if}
        </a>
      </li>
    {/each}
  </ul>
</nav>
