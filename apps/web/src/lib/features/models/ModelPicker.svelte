<script lang="ts">
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
  import { useFavoriteModels } from "./favorites.svelte.ts";
  import ProviderIcon from "./ProviderIcon.svelte";

  /**
   * T3-style model picker: the composer's model pill (provider mark, model, effort) opens a popover with
   * a rail (Favorites, then each provider), a search over every model, and the list — name, profile with
   * the provider mark, a star, ⌘1…⌘9 for the first nine favorites and a check on the current one.
   * Typing a model id the list does not know offers it as a custom model. Keys in the search field:
   * arrows + Enter choose, Mod+1…9 pick a favorite, Mod+Shift+F stars the highlighted model.
   */
  let {
    options,
    value,
    effort,
    open = $bindable(false),
    allowCustom = true,
    notice,
    onselect,
    class: className,
  }: {
    options: readonly ModelOption[];
    /** Key of the current option. */
    value: string | undefined;
    /** Effort label shown in the pill after the model ("High"). */
    effort?: string | undefined;
    open?: boolean;
    /** Offer "Use “…”" for a model id typed in the search. */
    allowCustom?: boolean;
    /** Note under the list (e.g. a choice that is not applied yet). */
    notice?: string | undefined;
    onselect: (option: ModelOption) => void;
    class?: ClassValue;
  } = $props();

  const favorites = useFavoriteModels();
  const FAVORITE_HOTKEY = "Mod+Shift+F";

  let query = $state("");
  let section = $state<"favorites" | ProviderKey>();
  const selected = $derived(options.find((o) => o.key === value));
  const providers = $derived([...new Set(options.map((o) => o.provider))]);
  const favoriteOptions = $derived(favorites.keys.flatMap((key) => options.find((o) => o.key === key) ?? []));
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
    return modelOption(provider, base.profileId, base.profileName, model, "custom");
  });

  const listed = $derived(
    searching ? [...options, ...(custom ? [custom] : [])] : current === "favorites" ? favoriteOptions : options.filter((o) => o.provider === current),
  );
  const shortcutOf = (key: string) => {
    const index = favoriteOptions.findIndex((o) => o.key === key);
    return index >= 0 && index < 9 ? `Mod+${index + 1}` : undefined;
  };

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
      favorites.toggle(active.key);
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
  class="w-[min(24rem,calc(100vw-1rem))]"
>
  {#snippet trigger(props)}
    <PillButton {...props} class={["pl-1.5", className]} aria-label="Model: {selected?.name ?? 'none'}{effort ? `, ${effort} effort` : ''}">
      {#if selected}<ProviderIcon provider={selected.provider} class="size-3.5" />{/if}
      <span class="truncate text-zinc-800 dark:text-zinc-200">{selected?.name ?? "Choose a model"}</span>
      {#if effort}<span class="shrink-0 text-zinc-500 dark:text-zinc-400">{effort}</span>{/if}
    </PillButton>
  {/snippet}

  <div class="flex h-[min(24rem,var(--float-available-height,24rem))] in-data-sheet:h-[70dvh]">
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
          <div class="flex items-center gap-2">
            {#if o.origin === "custom"}
              <Icon name="plus" class="fill-zinc-500 dark:fill-zinc-400" />
              <span class="min-w-0 flex-1 truncate">Use “{o.model}” <span class="text-zinc-500 dark:text-zinc-400">with {providerName(o.provider)} · {o.profileName}</span></span>
            {:else}
              <span class="grid min-w-0 flex-1">
                <span class="truncate font-medium" title={o.model || undefined}>{o.name}</span>
                <span class="flex min-w-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">
                  <ProviderIcon provider={o.provider} class="size-3" />
                  <span class="truncate">{o.profileName}</span>
                </span>
              </span>
              {#if shortcut}<Kbd hotkey={shortcut} />{/if}
              <IconButton
                icon="star"
                size="sm"
                tabindex={-1}
                label={favorites.has(o.key) ? `Remove ${o.name} from favorites` : `Add ${o.name} to favorites`}
                aria-pressed={favorites.has(o.key)}
                iconClass={favorites.has(o.key) ? "fill-amber-500" : ["fill-zinc-300 dark:fill-zinc-600", !state.active && "pointer-fine:invisible"]}
                onclick={(event) => {
                  event.stopPropagation();
                  favorites.toggle(o.key);
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
      <div class="flex shrink-0 items-center gap-3 border-t border-zinc-950/5 px-3 py-2 text-sm/5 text-zinc-500 sm:text-xs/4 dark:border-white/8 dark:text-zinc-400">
        {#if notice}
          <p class="min-w-0 flex-1 text-pretty">{notice}</p>
        {:else}
          <p class="min-w-0 flex-1 truncate">{favoriteOptions.length > 0 ? "Favorites have shortcuts" : "Star models you use often"}</p>
        {/if}
        <span class="flex shrink-0 items-center gap-1.5 pointer-coarse:hidden"><Kbd hotkey={FAVORITE_HOTKEY} />star</span>
      </div>
    </div>
  </div>
</Popover>
