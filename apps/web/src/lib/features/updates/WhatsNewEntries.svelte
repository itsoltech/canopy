<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { NoteEntry } from "@canopy/domain/release/notes";
  import { noteGroups } from "@canopy/domain/release/note-range";
  import Badge from "#lib/shared/ui/Badge.svelte";

  let { entries, class: className }: { entries: readonly NoteEntry[]; class?: ClassValue } = $props();
</script>

<div class={["grid min-w-0 gap-5", className]}>
  {#each noteGroups as group (group.type)}
    {@const items = entries.filter((entry) => entry.type === group.type)}
    {#if items.length}
      <section class="min-w-0">
        <h3 class="text-sm font-semibold text-balance">{group.title}</h3>
        <ul role="list" class="mt-2 grid gap-3">
          {#each items as entry}
            <li class="grid min-w-0 gap-1 text-base/6 sm:text-sm/6">
              <p class="break-anywhere text-pretty">
                {#if entry.url}<a
                    href={entry.url}
                    target="_blank"
                    rel="noreferrer"
                    class="rounded focus-ring hover:underline">{entry.summary}</a
                  >{:else}{entry.summary}{/if}
              </p>
              {#if entry.scope || entry.pr}
                <div class="flex min-w-0 flex-wrap items-center gap-1.5 text-xs/5 text-muted">
                  {#if entry.scope}<Badge compact
                      ><span class="max-w-40 truncate" title={entry.scope}>{entry.scope}</span></Badge
                    >{/if}
                  {#if entry.pr}<span class="tabular-nums">#{entry.pr}</span>{/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/each}
  {#if !entries.length}<p class="text-base/6 text-pretty text-muted sm:text-sm/6">
      No changes listed for this version.
    </p>{/if}
</div>
