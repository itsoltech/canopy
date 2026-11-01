<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { segmentedItem, segmentedTrack } from "#lib/shared/ui/segmented.ts";
  import { sectionMemory, sections, type Section } from "./sections.svelte.ts";

  /**
   * Segmented "Threads | Bots" switch at the top of the sidebar. Each segment links to the last page
   * of its section; `attention` puts a dot on a segment you are not in when something there needs you.
   */
  let { active, attention = {}, class: className }: { active: Section; attention?: Partial<Record<Section, boolean>>; class?: ClassValue } = $props();
</script>

<nav aria-label="Sections" class={className}>
  <ul role="list" class={["grid grid-cols-2", segmentedTrack]}>
    {#each sections as section (section.id)}
      {@const current = section.id === active}
      {@const dot = !current && attention[section.id]}
      <li>
        <a href={sectionMemory.href(section.id)} aria-current={current ? "true" : undefined} data-active={current || undefined} class={segmentedItem}>
          {section.label}
          {#if dot}<span class="size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden="true"></span><span class="sr-only">, needs you</span>{/if}
        </a>
      </li>
    {/each}
  </ul>
</nav>
