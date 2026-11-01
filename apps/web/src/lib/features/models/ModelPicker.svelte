<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import type { ProviderKey } from "#lib/features/threads/providers.ts";
  import Combobox from "#lib/shared/ui/Combobox.svelte";
  import { matchesHotkey } from "#lib/shared/ui/hotkeys.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Kbd from "#lib/shared/ui/Kbd.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { modelOption, providerName, searchText, type ModelOption } from "./catalog.ts";
  import { useFavoriteModels } from "./favorites.ts";
  import ProviderIcon from "./ProviderIcon.svelte";

  /**
   * T3-style model picker: the composer's model pill (provider mark, model, effort) opens a popover (a
   * bottom sheet on phones) with a rail (Favorites, then each provider), a search over every model, and
   * the list — name, profile and the catalog's description, a star, ⌘1…⌘9 for the first nine favorites
   * and a check on the current one. A provider with several profiles lists them under headings. The
   * footer says when a profile's list is incomplete and refreshes the worker's list. Typing a model id
   * the list does not know offers it as a custom model. Keys in the search field: arrows + Enter choose,
   * Mod+1…9 pick a favorite, Mod+Shift+F stars the highlighted model.
   */
  let {
    options,
    value,
    effort,
    catalog,
    open = $bindable(false),
    allowCustom = true,
    notice,
    refreshing = false,
    onrefresh,
    onselect,
    class: className,
  }: {
    options: readonly ModelOption[];
    /** Key of the current option. */
    value: string | undefined;
    /** Effort label shown in the pill after the model ("High"). */
    effort?: string | undefined;
    /** The worker's catalog: what it knows about a model id typed by hand. */
    catalog?: ui.WorkerModels | undefined;
    open?: boolean;
    /** Offer "Use “…”" for a model id typed in the search. */
    allowCustom?: boolean;
    /** Note in the footer (e.g. why the last refresh failed). */
    notice?: string | undefined;
    refreshing?: boolean;
    /** Read the worker's model list again (no button without it). */
    onrefresh?: (() => void) | undefined;
    onselect: (option: ModelOption) => void;
    class?: ClassValue;
  } = $props();

  const favorites = useFavoriteModels();
  const FAVORITE_HOTKEY = "Mod+Shift+F";

  let query = $state("");
  let section = $state<"favorites" | ProviderKey>();
  const selected = $derived(options.find((o) => o.key === value));
  const providers = $derived([...new Set(options.map((o) => o.provider))]);
  const favoriteOptions = $derived(favorites.among(options));
  const current = $derived(section ?? (favoriteOptions.length > 0 ? "favorites" : (selected?.provider ?? providers[0] ?? "favorites")));
  const searching = $derived(query.trim().length > 0);

  // A typed model id becomes an option of the provider in view, on the current profile when it matches.
  const custom = $derived.by(() => {
    const model = query.trim();
    if (!allowCustom || !model || /\s/.test(model)) return undefined;
    const provider = current !== "favorites" ? current : (selected?.provider ?? providers[0]);
    if (!provider) return undefined;
    const base = selected?.provider === provider ? selected : options.find((o) => o.provider === provider);
    if (!base || options.some((o) => o.provider === provider && o.profileId === base.profileId && o.model === model)) return undefined;
    return { ...modelOption(provider, base.profileId, base.profileName, model, catalog), origin: "custom" as const };
  });

  const listed = $derived(
    searching ? [...options, ...(custom ? [custom] : [])] : current === "favorites" ? favoriteOptions : options.filter((o) => o.provider === current),
  );
  // Headings only where profiles mix: a provider's profiles, or a search over several providers/profiles.
  const sourceOf = (o: ModelOption) => `${o.provider}:${o.profileId}`;
  const grouped = $derived(current !== "favorites" || searching ? new Set(listed.filter((o) => o.origin !== "custom").map(sourceOf)).size > 1 : false);
  const groupOf = (o: ModelOption) => (!grouped || o.origin === "custom" ? undefined : searching ? `${providerName(o.provider)} · ${o.profileName}` : o.profileName);
  // Incomplete lists of the profiles in view (the catalog says why).
  const details = $derived(
    [...new Map(listed.filter((o) => o.listDetail).map((o) => [sourceOf(o), `${providerName(o.provider)} · ${o.profileName}: ${o.listDetail}`])).values()],
  );
  const shortcutOf = (key: string) => {
    const index = favoriteOptions.findIndex((o) => o.key === key);
    return index >= 0 && index < 9 ? `Mod+${index + 1}` : undefined;
  };
  const secondary = (o: ModelOption) => [grouped ? "" : o.profileName, o.description || (o.model && o.name !== o.model ? o.model : "")].filter(Boolean).join(" · ");

  function choose(option: ModelOption) {
    onselect(option);
    open = false;
  }

  function onkeydown(event: KeyboardEvent, active: ModelOption | undefined) {
    for (let n = 1; n <= 9; n++) {
      if (matchesHotkey(event, `Mod+${n}`)) {
        event.preventDefault();
        const favorite = favoriteOptions[n - 1];
        if (favorite) choose(favorite);
        return;
      }
    }
    if (matchesHotkey(event, FAVORITE_HOTKEY) && active && active.origin !== "custom") {
      event.preventDefault();
      favorites.toggle(active);
    }
  }
</script>

<Popover
  bind:open
  label="Choose a model"
  placement="top-start"
  sheet
  onclose={() => {
    query = "";
    section = undefined;
  }}
  class="w-[min(26rem,calc(100vw-1rem))]"
>
  {#snippet trigger(props)}
    <PillButton {...props} class={["pl-1.5", className]} aria-label="Model: {selected?.name ?? 'none'}{effort ? `, ${effort} effort` : ''}">
      {#if selected}<ProviderIcon provider={selected.provider} class="size-3.5" />{/if}
      <span class="truncate text-zinc-800 dark:text-zinc-200">{selected?.name ?? "Choose a model"}</span>
      {#if effort}<span class="shrink-0 text-zinc-500 dark:text-zinc-400">{effort}</span>{/if}
    </PillButton>
  {/snippet}

  <div class="flex h-[min(26rem,var(--float-available-height,26rem))] in-data-sheet:h-[70dvh]">
    <div role="group" aria-label="Show models" class="flex shrink-0 flex-col items-center gap-1 border-r border-zinc-950/5 p-1.5 dark:border-white/8">
      {#snippet railButton(target: "favorites" | ProviderKey, label: string)}
        {@const pressed = !searching && current === target}
        <button
          type="button"
          class="relative grid size-9 place-items-center rounded-lg focus-ring hover:bg-zinc-950/5 aria-pressed:bg-zinc-950/6 sm:size-8 dark:hover:bg-white/5 dark:aria-pressed:bg-white/10"
          aria-label={label}
          aria-pressed={pressed}
          onclick={() => {
            section = target;
            query = "";
          }}
          {@attach tooltip(label, { placement: "right" })}
        >
          {#if target === "favorites"}
            <Icon name="star" class={pressed ? "fill-amber-500" : "fill-zinc-400 dark:fill-zinc-500"} />
          {:else}
            <ProviderIcon provider={target} class={pressed ? undefined : "opacity-60 grayscale"} />
          {/if}
        </button>
      {/snippet}
      {@render railButton("favorites", "Favorites")}
      {#each providers as provider (provider)}{@render railButton(provider, providerName(provider))}{/each}
    </div>

    <div class="flex min-w-0 flex-1 flex-col">
      <Combobox
        inline
        autofocus
        items={listed}
        key={(o) => o.key}
        text={searchText}
        {groupOf}
        bind:query
        {value}
        label="Search models"
        placeholder="Search models…"
        onselect={choose}
        {onkeydown}
        class="min-h-0 flex-1"
      >
        {#snippet option(o, state)}
          {@const shortcut = shortcutOf(o.key)}
          {@const starred = favorites.has(o)}
          {@const line = secondary(o)}
          <div class="flex items-center gap-2">
            {#if o.origin === "custom"}
              <Icon name="plus" class="fill-zinc-500 dark:fill-zinc-400" />
              <span class="min-w-0 flex-1 truncate">Use “{o.model}” <span class="text-zinc-500 dark:text-zinc-400">with {providerName(o.provider)} · {o.profileName}</span></span>
            {:else}
              <span class="grid min-w-0 flex-1">
                <span class="truncate font-medium" title={o.model || undefined}>{o.name}</span>
                {#if line}
                  <span class="flex min-w-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">
                    {#if !grouped}<ProviderIcon provider={o.provider} class="size-3" />{/if}
                    <span class="truncate" title={o.description || undefined}>{line}</span>
                  </span>
                {/if}
              </span>
              {#if shortcut}<Kbd hotkey={shortcut} />{/if}
              <IconButton
                icon="star"
                size="sm"
                tabindex={-1}
                label={starred ? `Remove ${o.name} (${o.profileName}) from favorites` : `Add ${o.name} (${o.profileName}) to favorites`}
                aria-pressed={starred}
                iconClass={starred ? "fill-amber-500" : ["fill-zinc-300 dark:fill-zinc-600", !state.active && "pointer-fine:invisible"]}
                onclick={(event) => {
                  event.stopPropagation();
                  favorites.toggle(o);
                }}
              />
              <Icon name="check" class={["fill-brand-600 dark:fill-brand-400", !state.selected && "invisible"]} />
            {/if}
          </div>
        {/snippet}
        {#snippet empty(q)}
          {#if q}
            No models match “{q}”.
          {:else if current === "favorites"}
            <span class="grid justify-items-center gap-1">
              <Icon name="star" class="fill-zinc-300 dark:fill-zinc-600" />
              Star a model to keep it here.
            </span>
          {:else}
            No models.
          {/if}
        {/snippet}
      </Combobox>
      <div class="flex shrink-0 items-center gap-2 border-t border-zinc-950/5 py-1.5 pr-1.5 pl-3 text-sm/5 text-zinc-500 sm:text-xs/4 dark:border-white/8 dark:text-zinc-400">
        {#if notice}
          <p class="min-w-0 flex-1 text-pretty" role="status">{notice}</p>
        {:else if details.length > 0}
          <p class="flex min-w-0 flex-1 items-center gap-1.5" title={details.join("\n")}>
            <Icon name="information-circle" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />
            <span class="truncate">{details.length === 1 ? `Incomplete list. ${details[0]}` : `${details.length} lists are incomplete.`}</span>
          </p>
        {:else}
          <p class="min-w-0 flex-1 truncate">{favoriteOptions.length > 0 ? "Favorites have shortcuts" : "Star models you use often"}</p>
        {/if}
        <span class="flex shrink-0 items-center gap-1.5 pointer-coarse:hidden"><Kbd hotkey={FAVORITE_HOTKEY} />star</span>
        {#if onrefresh}
          <IconButton
            icon="arrow-path"
            size="sm"
            label={refreshing ? "Refreshing the model list…" : "Refresh the model list"}
            disabled={refreshing}
            iconClass={refreshing ? "motion-safe:animate-spin" : undefined}
            onclick={onrefresh}
          />
        {/if}
      </div>
    </div>
  </div>
</Popover>
