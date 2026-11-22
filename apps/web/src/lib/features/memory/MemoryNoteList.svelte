<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { noteScopeLabel } from "@canopy/domain/memory-scopes";
  import { dayKey, formatDay, formatEnglishDateTime, isoDateTime } from "#lib/shared/format.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";

  let {
    notes,
    query,
    onopen,
  }: {
    notes: readonly ui.MemoryNote[];
    query: string;
    onopen: (note: ui.MemoryNote) => void;
  } = $props();

  const groups = $derived(Map.groupBy(notes, (note) => dayKey(note.updatedAt)));
  const term = $derived(query.toLowerCase().replace(/\s+/g, " "));

  function preview(note: ui.MemoryNote) {
    const body = note.body.replace(/\s+/g, " ");

    if (!term || note.title.toLowerCase().includes(term)) return body;

    const at = body.toLowerCase().indexOf(term);

    if (at >= 0) return at > 24 ? `…${body.slice(at - 24)}` : body;

    const alias = note.aliases.find((value) => value.toLowerCase().includes(term));

    return alias ? `Alias · ${alias}` : body;
  }
</script>

<div class="grid min-w-0 gap-3">
  {#each groups as [day, entries] (day)}
    <div class="grid min-w-0 gap-1.5">
      <h4 class="px-1 text-sm/5 font-medium text-muted">{formatDay(entries[0]?.updatedAt) || "Unknown date"}</h4>
      <SettingsCard>
        <ul role="list" class="divide-y divide-divider">
          {#each entries as note (note.id)}
            {@const titleId = `memory-title-${note.id}`}
            {@const metadataId = `memory-metadata-${note.id}`}
            <li>
              <button
                type="button"
                aria-labelledby={titleId}
                aria-describedby={metadataId}
                class="settings-row flex w-full min-w-0 items-center gap-2 px-3 py-2 text-start focus-ring hover:bg-zinc-950/5 focus-visible:-outline-offset-2 sm:gap-3 dark:hover:bg-white/5"
                onclick={() => onopen(note)}
              >
                <span
                  class="grid min-w-0 flex-1 items-center gap-x-4 @min-[38rem]/settings-content:grid-cols-[minmax(0,1fr)_minmax(0,33%)]"
                >
                  <span class="grid min-w-0">
                    <span id={titleId} class="flex min-w-0 items-center gap-2">
                      <TruncatedText text={note.title} class="text-base/6 font-medium sm:text-sm/5" />
                      {#if note.pinned}<Badge compact>Pinned</Badge>{/if}
                    </span>
                    <span
                      class={[
                        "truncate text-sm/5 text-muted sm:text-xs/5",
                        !term && "hidden @min-[38rem]/settings-content:block",
                      ]}>{preview(note)}</span
                    >
                  </span>
                  <span id={metadataId} class="grid min-w-0 @min-[38rem]/settings-content:text-end">
                    <TruncatedText text={noteScopeLabel(note)} class="text-sm/5 text-muted sm:text-xs/5" />
                    {#if note.createdAt}
                      <time
                        class="text-sm/5 text-muted tabular-nums sm:text-xs/5"
                        datetime={isoDateTime(note.createdAt)}
                      >
                        Created {formatEnglishDateTime(note.createdAt)}
                      </time>
                    {/if}
                  </span>
                </span>
                <Icon name="chevron-right" tone="muted" />
              </button>
            </li>
          {/each}
        </ul>
      </SettingsCard>
    </div>
  {/each}
</div>
