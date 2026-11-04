<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ModelInfo, ui } from "@canopy/contracts";
  import { flip } from "svelte/animate";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import { duration } from "#lib/shared/ui/motion.ts";
  import {
    matchesModel,
    modelRows,
    withAllVisible,
    withCustom,
    withFavorite,
    withFavoriteMoved,
    withVisibility,
    type ModelRow,
  } from "./instances.ts";

  /**
   * An instance's models in the pickers (T3 Models section): favorites first (star, move up and down, ⌘1… in the
   * picker), the rest, and the ones hidden from the picker, each with a switch; capability tags from the catalog;
   * a filter, hide all / show all, and custom model ids the catalog does not list. Every change saves at once (the
   * pickers follow live); a failed save goes back.
   */
  let {
    catalog,
    models,
    onchange,
    class: className,
  }: {
    /** The workers' catalog for this instance (unfiltered). */
    catalog: readonly ModelInfo[];
    models: ui.InstanceModels | undefined;
    onchange: (next: ui.InstanceModels) => Promise<void>;
    class?: ClassValue;
  } = $props();

  let query = $state("");
  let custom = $state("");
  let pending = $state<ui.InstanceModels>();
  const current = $derived(pending ?? models);
  const rows = $derived(modelRows(catalog, current));
  const visible = $derived(rows.filter((r) => matchesModel(r, query)));

  const groups = $derived([
    { title: "Favorites", rows: visible.filter((r) => r.favorite && !r.hidden) },
    { title: "All models", rows: visible.filter((r) => !r.favorite && !r.hidden) },
    { title: "Hidden from picker", rows: visible.filter((r) => r.hidden) },
  ]);

  const counts = $derived({
    all: rows.length,
    favorites: rows.filter((r) => r.favorite).length,
    hidden: rows.filter((r) => r.hidden).length,
  });

  const favoriteIds = $derived(rows.filter((r) => r.favorite).map((r) => r.id));

  async function change(next: ui.InstanceModels) {
    pending = next;

    try {
      await onchange(next);
    } finally {
      pending = undefined;
    }
  }

  function addCustom(event: SubmitEvent) {
    event.preventDefault();
    const id = custom.trim();

    if (!id || /\s/.test(id) || rows.some((r) => r.id === id)) return;
    custom = "";
    void change(withCustom(current, id, true));
  }
</script>

<div class={["grid gap-4", className]}>
  <div class="flex flex-wrap items-center gap-2">
    <SearchField
      label="Filter models"
      name="model-filter"
      bind:value={query}
      placeholder="Filter models"
      class="min-w-0 flex-1 basis-48"
    />
    {#if counts.hidden < counts.all}
      <Button size="sm" onclick={() => change(withAllVisible(current, visible, false))}
        >{query ? "Hide these" : "Hide all"}</Button
      >
    {:else}
      <Button size="sm" onclick={() => change(withAllVisible(current, visible, true))}
        >{query ? "Show these" : "Show all"}</Button
      >
    {/if}
  </div>
  <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
    {counts.all} model{counts.all === 1 ? "" : "s"} · {counts.favorites} favorite{counts.favorites === 1 ? "" : "s"} · {counts.hidden}
    hidden
  </p>

  {#if rows.length === 0}
    <EmptyState
      icon="cpu-chip"
      title="No models listed yet"
      description="The workers send the instance's models once it runs there. Custom model ids work right away."
    />
  {/if}

  {#each groups as group (group.title)}
    {#if group.rows.length > 0}
      <section aria-label={group.title}>
        <h4 class="px-1 text-sm/6 font-medium text-zinc-500 sm:text-xs/6 dark:text-zinc-400">{group.title}</h4>
        <InsetList class="mt-1">
          {#each group.rows as row (row.id)}
            {@const index = favoriteIds.indexOf(row.id)}
            <li class="flex items-center gap-2 py-2 pr-3 pl-1.5" animate:flip={{ duration: duration("fast") }}>
              <IconButton
                icon="star"
                size="sm"
                label={row.favorite ? `Remove ${row.name} from favorites` : `Add ${row.name} to favorites`}
                aria-pressed={row.favorite}
                iconClass={row.favorite ? "fill-amber-500" : "fill-zinc-300 dark:fill-zinc-600"}
                onclick={() => change(withFavorite(current, row.id, !row.favorite))}
              />
              <div class="min-w-0 flex-1">
                <p class="flex min-w-0 items-center gap-2">
                  <span class="truncate text-base/6 text-zinc-950 sm:text-sm/6 dark:text-white">{row.name}</span>
                  {#each row.tags as tag (tag)}<Badge tone={tag === "custom" ? "violet" : "neutral"}>{tag}</Badge
                    >{/each}
                </p>
                {#if row.name !== row.id || row.description}
                  <p class="truncate text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
                    {[row.name !== row.id ? row.id : "", row.description].filter(Boolean).join(" · ")}
                  </p>
                {/if}
              </div>
              {#if row.favorite && !row.hidden}
                <IconButton
                  icon="arrow-up"
                  size="sm"
                  label="Move {row.name} up"
                  disabled={index <= 0}
                  onclick={() => change(withFavoriteMoved(current, row.id, -1))}
                />
                <IconButton
                  icon="arrow-down"
                  size="sm"
                  label="Move {row.name} down"
                  disabled={index >= favoriteIds.length - 1}
                  onclick={() => change(withFavoriteMoved(current, row.id, 1))}
                />
              {/if}
              {#if row.custom}
                <IconButton
                  icon="trash"
                  size="sm"
                  label="Remove {row.name}"
                  onclick={() => change(withCustom(current, row.id, false))}
                />
              {/if}
              <Switch
                name="model-{row.id}-shown"
                label="Show {row.name} in the picker"
                checked={!row.hidden}
                onchange={(on) => change(withVisibility(current, row as ModelRow, on))}
              />
            </li>
          {/each}
        </InsetList>
      </section>
    {/if}
  {/each}

  <form class="flex items-center gap-2" onsubmit={addCustom}>
    <Input
      name="custom-model"
      bind:value={custom}
      placeholder="Custom model id, e.g. gpt-6.1-sol-fast"
      aria-label="Custom model id"
      autocomplete="off"
      spellcheck="false"
      class="min-w-0 flex-1 font-mono"
    />
    <Button type="submit" size="sm" icon="plus" disabled={!custom.trim()}>Add custom model</Button>
  </form>
  <p class="-mt-2 flex items-start gap-1.5 text-sm/5 text-pretty text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    <Icon name="information-circle" class="mt-0.5 size-3.5 shrink-0 fill-zinc-400" />Hidden models stay usable in
    threads that already run on them.
  </p>
</div>
