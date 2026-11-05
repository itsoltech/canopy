<script lang="ts">
  import AccentDot from "./AccentDot.svelte";
  import EffortLabel from "./EffortLabel.svelte";
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Combobox from "#lib/shared/ui/Combobox.svelte";
  import { keybindings } from "#lib/features/commands/keybindings.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Kbd from "#lib/shared/ui/Kbd.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import { instanceKeyOf, modelOption, providerName, searchText, type ModelOption } from "./catalog.ts";
  import { useFavoriteModels } from "./favorites.ts";
  import { instanceTitle, pickerInstances } from "./picker-instances.ts";
  import ModelPickerRail from "./ModelPickerRail.svelte";
  import ModelRow from "./ModelRow.svelte";
  import ProviderIcon from "./ProviderIcon.svelte";

  /**
   * Model picker: the composer's model pill (provider mark, model, effort) opens a popover (a
   * bottom sheet on phones) with a rail (Favorites, then one tab per provider instance; the selected model's
   * instance is in view on open), a search over every model grouped by instance, and the list — concrete name,
   * a star, ⌘1…⌘9 for the first nine favorites and a check on the current one. Where a provider has several
   * instances, favorite rows and the pill name the instance ("Claude Opus 5.5 · Proxy"). The footer says when an
   * instance's list is incomplete and refreshes the worker's list. Typing a model id the list does not know
   * offers it as a custom model of the instance in view. Keys in the search field: arrows + Enter choose,
   * Alt+Up/Down switch tabs, Mod+1…9 pick a favorite, Mod+Shift+F stars the highlighted model.
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
  const FAVORITE_HOTKEY = $derived(keybindings.get("model:favorite")[0] ?? "");

  let query = $state("");

  /** "favorites" or the key of an instance (`instanceKeyOf`). */
  let section = $state<string>();
  let expandedLegacy = $state<ReadonlyMap<string, boolean>>(new Map());
  const selected = $derived(options.find((o) => o.key === value));
  const instances = $derived(pickerInstances(options));
  const favoriteOptions = $derived(favorites.among(options));
  const instanceOf = (o: ModelOption) => instances.find((i) => i.key === instanceKeyOf(o));

  // The pill names the instance only where the provider has several ("Claude Opus 5.5 · Proxy").
  const selectedInstance = $derived(selected && instanceOf(selected)?.shared ? selected : undefined);

  const current = $derived(
    section ??
      (selected
        ? instanceKeyOf(selected)
        : favoriteOptions.length > 0
          ? "favorites"
          : (instances[0]?.key ?? "favorites")),
  );

  const searching = $derived(query.trim().length > 0);

  // A typed model id becomes an option of the instance in view (else the selected model's, else the first).
  const custom = $derived.by(() => {
    const model = query.trim();

    if (!allowCustom || !model || /\s/.test(model)) return undefined;

    const base =
      instances.find((i) => i.key === current) ?? (selected ? instanceOf(selected) : undefined) ?? instances[0];

    if (!base || options.some((o) => instanceKeyOf(o) === base.key && o.model === model)) return undefined;

    return {
      ...modelOption(base.provider, base.profileId, base.name, model, catalog),
      origin: "custom" as const,
    };
  });

  const offered = $derived(
    searching
      ? [...options, ...(custom ? [custom] : [])]
      : current === "favorites"
        ? favoriteOptions
        : options.filter((o) => instanceKeyOf(o) === current),
  );

  const sourceOf = instanceKeyOf;

  const legacyGroups = $derived.by(() => {
    if (searching || current === "favorites") return new Map<string, string>();

    return new Map(
      [...new Set(offered.map(sourceOf))].flatMap((source) => {
        const count = offered.filter((o) => sourceOf(o) === source && o.legacy).length;

        return count ? [[source, `Legacy models · ${count.toLocaleString()} ${count === 1 ? "model" : "models"}`]] : [];
      }),
    );
  });

  const listed = $derived(
    legacyGroups.size === 0
      ? offered
      : [...new Set(offered.map(sourceOf))].flatMap((source) => {
          const own = offered.filter((o) => sourceOf(o) === source);

          return [...own.filter((o) => !o.legacy), ...own.filter((o) => o.legacy)];
        }),
  );

  // An instance tab lists one instance; a search over several instances groups the results by instance.
  const grouped = $derived(searching && new Set(listed.filter((o) => o.origin !== "custom").map(sourceOf)).size > 1);

  const groupOf = (o: ModelOption) => {
    if (o.origin === "custom") return undefined;
    const legacy = o.legacy ? legacyGroups.get(sourceOf(o)) : undefined;

    if (legacy) return legacy;

    if (!grouped) return undefined;
    const instance = instanceOf(o);

    return instance ? instanceTitle(instance) : `${providerName(o.provider)} · ${o.profileName}`;
  };

  // Legacy groups open and close per instance (two instances can have the same heading).
  const groupExpanded = (group: string) => {
    const legacy = listed.filter((o) => o.legacy && legacyGroups.has(sourceOf(o)) && groupOf(o) === group);

    if (!legacy.length) return undefined;

    return expandedLegacy.get(`${current}|${group}`) ?? legacy.some((o) => o.key === value);
  };

  // Favorites mix instances: their rows name the instance where its provider has several.
  const rowInstance = (o: ModelOption) => {
    const instance = current === "favorites" && !searching ? instanceOf(o) : undefined;

    return instance?.shared ? instance : undefined;
  };

  const tabs = $derived(["favorites", ...instances.map((i) => i.key)]);

  function pickTab(target: string) {
    section = target;
    query = "";
  }

  // Incomplete lists of the profiles in view (the catalog says why).
  const details = $derived([
    ...new Map(
      listed
        .filter((o) => o.listDetail)
        .map((o) => [sourceOf(o), `${providerName(o.provider)} · ${o.profileName}: ${o.listDetail}`]),
    ).values(),
  ]);

  const shortcutOf = (key: string) => {
    const index = favoriteOptions.findIndex((o) => o.key === key);

    return index >= 0 && index < 9 ? keybindings.get(`model:pick-${index + 1}`)[0] : undefined;
  };

  function choose(option: ModelOption) {
    onselect(option);
    open = false;
  }

  function onkeydown(event: KeyboardEvent, active: ModelOption | undefined) {
    const step = keybindings.matches(event, "model:next-tab")
      ? 1
      : keybindings.matches(event, "model:previous-tab")
        ? -1
        : 0;

    if (step) {
      event.preventDefault();
      const index = searching ? (step > 0 ? -1 : 0) : tabs.indexOf(current);
      pickTab(tabs[(index + step + tabs.length) % tabs.length]!);

      return;
    }

    for (let n = 1; n <= 9; n++) {
      if (keybindings.matches(event, `model:pick-${n}`)) {
        event.preventDefault();
        const favorite = favoriteOptions[n - 1];

        if (favorite) choose(favorite);

        return;
      }
    }

    if (keybindings.matches(event, "model:favorite") && active && active.origin !== "custom") {
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
    expandedLegacy = new Map();
  }}
  class="w-[min(26rem,calc(100vw-1rem))]"
>
  {#snippet trigger(props)}
    <PillButton
      {...props}
      class={["pl-1.5", className]}
      aria-label="Model: {selected?.name ?? 'none'}{selected
        ? ` · ${selected.profileName} · ${selected.model}`
        : ''}{effort ? `, ${effort} effort` : ''}"
    >
      {#if selected}<span class="relative shrink-0"
          ><ProviderIcon provider={selected.provider} class="size-3.5" />{#if selectedInstance}<AccentDot
              accent={selectedInstance.accent}
              class="absolute -right-0.5 -bottom-0.5 size-1.5 ring-1 ring-surface"
            />{/if}</span
        >{/if}
      <span class="truncate text-zinc-800 dark:text-zinc-200"
        >{selected?.name ?? "Choose a model"}{#if selectedInstance}<span class="text-zinc-500 dark:text-zinc-400"
            >&nbsp;· {selectedInstance.profileName}</span
          >{/if}</span
      >
      {#if effort}<span class="shrink-0 text-zinc-500 dark:text-zinc-400"
          ><EffortLabel
            label={effort}
            rank={Math.max(0, selected?.efforts.findIndex((e) => e.id === effort) ?? 0)}
            total={selected?.efforts.length ?? 5}
          /></span
        >{/if}
    </PillButton>
  {/snippet}

  <!-- Fixed height: clip, so the bottom buttons' touch targets don't make the panel scroll by a few pixels. -->
  <div class="flex h-[min(26rem,var(--float-available-height,26rem))] overflow-clip in-data-sheet:h-[70dvh]">
    <ModelPickerRail {instances} {current} {searching} onpick={pickTab} />

    <div class="flex min-w-0 flex-1 flex-col">
      <Combobox
        inline
        autofocus
        items={listed}
        key={(o) => o.key}
        text={searchText}
        {groupOf}
        {groupExpanded}
        ontogglegroup={(group) => {
          expandedLegacy = new Map(expandedLegacy).set(`${current}|${group}`, !groupExpanded(group));
        }}
        bind:query
        {value}
        label="Search models"
        placeholder="Search models…"
        onselect={choose}
        {onkeydown}
        class="min-h-0 flex-1"
      >
        {#snippet option(o, state)}
          <ModelRow
            option={o}
            active={state.active}
            selected={state.selected}
            starred={favorites.has(o)}
            shortcut={shortcutOf(o.key)}
            instance={rowInstance(o)}
            onstar={() => favorites.toggle(o)}
          />
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
      <div
        class="flex shrink-0 items-center gap-2 border-t border-zinc-950/5 py-1.5 pr-1.5 pl-3 text-sm/5 text-zinc-500 sm:text-xs/4 dark:border-white/8 dark:text-zinc-400"
      >
        {#if notice}
          <p class="min-w-0 flex-1 text-pretty" role="status">{notice}</p>
        {:else if details.length > 0}
          <p class="flex min-w-0 flex-1 items-center gap-1.5" title={details.join("\n")}>
            <Icon name="information-circle" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />
            <span class="truncate"
              >{details.length === 1
                ? `Incomplete list. ${details[0]}`
                : `${details.length} lists are incomplete.`}</span
            >
          </p>
        {:else}
          <p class="min-w-0 flex-1 truncate">
            {favoriteOptions.length > 0 ? "Favorites have shortcuts" : "Star models you use often"}
          </p>
        {/if}
        <span class="flex shrink-0 items-center gap-1.5 pointer-coarse:hidden"
          ><Kbd hotkey={FAVORITE_HOTKEY} />star</span
        >
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
