<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { sectionMemory, sections, type Section } from "./sections.svelte.ts";

  /**
   * Segmented "Threads | Bots" switch at the top of the sidebar. Each segment links to the last page
   * of its section; `attention` puts a dot on a segment you are not in when something there needs you.
   */
  let { active, attention = {}, class: className }: { active: Section; attention?: Partial<Record<Section, boolean>>; class?: ClassValue } = $props();
</script>

<nav aria-label="Sections" class={className}>
  <ul role="list" class="grid grid-cols-2 gap-0.5 rounded-lg bg-zinc-950/5 p-0.5 dark:bg-white/5">
    {#each sections as section (section.id)}
      {@const current = section.id === active}
      {@const dot = !current && attention[section.id]}
      <li>
        <a
          href={sectionMemory.href(section.id)}
          aria-current={current ? "true" : undefined}
          class="flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-base/6 font-medium text-zinc-500 hover:text-zinc-950 focus-ring aria-[current]:bg-white aria-[current]:text-zinc-950 aria-[current]:shadow-xs aria-[current]:ring-1 aria-[current]:ring-zinc-950/5 sm:py-1 sm:text-sm/6 dark:text-zinc-400 dark:hover:text-white dark:aria-[current]:bg-white/10 dark:aria-[current]:text-white dark:aria-[current]:shadow-none dark:aria-[current]:ring-0"
        >
          {section.label}
          {#if dot}<span class="size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden="true"></span><span class="sr-only">, needs you</span>{/if}
        </a>
      </li>
    {/each}
  </ul>
</nav>
