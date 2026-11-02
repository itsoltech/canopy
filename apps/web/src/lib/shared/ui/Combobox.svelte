<script lang="ts" generics="T">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { useField } from "./field.ts";
  import Icon from "./Icon.svelte";
  import Input from "./Input.svelte";
  import { listboxHeadingClasses, listboxOptionClasses } from "./listbox.ts";
  import Popover from "./Popover.svelte";
  import Spinner from "./Spinner.svelte";

  /**
   * Combobox (WAI-ARIA 1.2: a text input that filters a listbox). Focus stays in the input; arrows move
   * the active option, Enter chooses it, Escape closes the list (or clears the search).
   * - Autocomplete (default): the list pops up under the input; the input's text is the value
   *   (`name` submits it), choosing an option fills it in.
   * - `inline`: the list is always shown under a search field (pickers inside a popover).
   * Async: pass `filter={false}`, update `items` when `query` changes, and set `loading` meanwhile.
   *
   *   <Combobox items={models} key={(m) => m} text={(m) => m} bind:query={model} name="model" label="Model" />
   *   <Combobox inline items={options} key={(o) => o.key} text={(o) => o.name} onselect={pick} label="Search models">
   *     {#snippet option(o, state)}…{/snippet}
   *   </Combobox>
   */
  let {
    items,
    key,
    text,
    query = $bindable(""),
    value = $bindable(),
    filter,
    onselect,
    onchange,
    inline = false,
    loading = false,
    label,
    name,
    placeholder,
    autofocus = false,
    groupOf,
    onkeydown: extraKeydown,
    class: className,
    listClass,
    option,
    empty,
  }: {
    items: readonly T[];
    key: (item: T) => string;
    /** Text of an item: what the default filter searches and what autocomplete fills in. */
    text: (item: T) => string;
    query?: string;
    /** Key of the chosen item (marks it as selected). */
    value?: string | undefined;
    /** Custom match, or `false` when `items` are already filtered (server-side search). */
    filter?: ((item: T, query: string) => boolean) | false;
    onselect?: ((item: T) => void) | undefined;
    /** Autocomplete: the text was committed (an option chosen, or edited and left / Enter). */
    onchange?: ((text: string) => void) | undefined;
    inline?: boolean;
    loading?: boolean;
    label: string;
    name?: string | undefined;
    placeholder?: string | undefined;
    autofocus?: boolean;
    /** Group heading of an item; consecutive items with the same group share one heading. */
    groupOf?: ((item: T) => string | undefined) | undefined;
    /** Runs first on every key in the input, with the active item (picker hotkeys). */
    onkeydown?: ((event: KeyboardEvent, active: T | undefined) => void) | undefined;
    class?: ClassValue;
    listClass?: ClassValue;
    option?: Snippet<[T, { active: boolean; selected: boolean }]> | undefined;
    empty?: Snippet<[string]> | undefined;
  } = $props();

  const id = $props.id();
  const field = useField();
  const inputId = $derived(field?.id ?? `${id}-input`);
  let input = $state<HTMLInputElement>();
  let open = $state(false);
  let activeKey = $state<string>();

  const defaultFilter = (item: T, q: string) => {
    const haystack = text(item).toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
  };
  // Autocomplete lists everything when opened and filters once you type (inline pickers always filter).
  let typed = $state(false);
  const filtering = $derived(filter !== false && Boolean(query.trim()) && (inline || typed));
  const visible = $derived(filtering ? items.filter((item) => (filter || defaultFilter)(item, query.trim())) : items);
  const active = $derived(visible.find((item) => key(item) === activeKey) ?? visible.find((item) => key(item) === value) ?? visible[0]);
  const activeIndex = $derived(active ? visible.indexOf(active) : -1);
  const listOpen = $derived(inline || open);
  const groups = $derived.by(() => {
    const out: { label: string | undefined; entries: { item: T; index: number }[] }[] = [];
    visible.forEach((item, index) => {
      const label = groupOf?.(item);
      const last = out.at(-1);
      if (last && last.label === label) last.entries.push({ item, index });
      else out.push({ label, entries: [{ item, index }] });
    });
    return out;
  });
  const optionId = (index: number) => `${id}-option-${index}`;

  $effect(() => {
    if (!listOpen || activeIndex < 0) return;
    // The first option scrolls to the very top, so a heading above it stays in view.
    if (activeIndex === 0) document.getElementById(`${id}-list`)?.scrollTo({ top: 0 });
    else document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  });

  function choose(item: T) {
    value = key(item);
    activeKey = value;
    if (!inline) {
      query = text(item);
      open = false;
      onchange?.(query);
    }
    onselect?.(item);
  }

  function move(delta: number) {
    if (visible.length === 0) return;
    const next = activeIndex < 0 ? (delta > 0 ? 0 : visible.length - 1) : (activeIndex + delta + visible.length) % visible.length;
    activeKey = key(visible[next]!);
  }

  function onkeydown(event: KeyboardEvent) {
    extraKeydown?.(event, listOpen ? active : undefined);
    if (event.defaultPrevented || event.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        if (!listOpen) {
          open = true;
          return;
        }
        move(event.key === "ArrowDown" ? 1 : -1);
        return;
      case "PageDown":
      case "PageUp":
        if (!listOpen) return;
        event.preventDefault();
        move(event.key === "PageDown" ? 8 : -8);
        return;
      case "Enter":
        if (listOpen && active) {
          event.preventDefault();
          choose(active);
        }
        return;
      case "Escape":
        if (!inline && open) {
          event.preventDefault();
          event.stopPropagation();
          open = false;
        } else if (inline && query) {
          event.preventDefault();
          event.stopPropagation();
          query = "";
        }
        return;
    }
  }

  function focusOnMount(node: HTMLInputElement) {
    if (autofocus) node.focus();
  }
</script>

{#snippet list()}
  <ul
    id="{id}-list"
    role="listbox"
    aria-label={label}
    class={["grid grid-cols-1 content-start", inline ? "min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5" : "p-1", listClass]}
  >
    {#each groups as group, g (g)}
      {#if group.label}
        <!-- Sticky over the list's padding: a long group keeps its heading in view. The truncating box is
             inside: a grid row of an overflow-hidden item may shrink to nothing in the scrolling list. -->
        <li
          role="presentation"
          class={[listboxHeadingClasses, inline ? "-mx-1.5 px-4" : "-mx-1 px-3.5"]}
        >
          <div class="truncate">{group.label}</div>
        </li>
      {/if}
      {#each group.entries as { item, index } (key(item))}
        {@const isActive = index === activeIndex}
        {@const selected = key(item) === value}
        <!-- Keys reach options through the input (aria-activedescendant); a click picks with the pointer. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={optionId(index)}
          role="option"
          aria-selected={selected}
          data-active={isActive || undefined}
          class={["group/option relative", listboxOptionClasses]}
          onpointerdown={(event) => event.preventDefault()}
          onpointermove={() => (activeKey = key(item))}
          onclick={() => choose(item)}
        >
          {#if option}
            {@render option(item, { active: isActive, selected })}
          {:else}
            <span class="flex items-center gap-2"><span class="min-w-0 flex-1 truncate">{text(item)}</span>{#if selected}<Icon name="check" class="fill-brand-600 dark:fill-brand-400" />{/if}</span>
          {/if}
        </li>
      {/each}
    {/each}
  </ul>
  {#if loading}
    <p class="flex items-center gap-2 px-4 py-2 text-sm/5 text-zinc-500 dark:text-zinc-400" role="status"><Spinner class="size-3.5" />Loading…</p>
  {:else if visible.length === 0}
    <div class="px-4 py-6 text-center text-sm/5 text-zinc-500 dark:text-zinc-400" role="status">
      {#if empty}{@render empty(query)}{:else}No matches{query ? ` for “${query}”` : ""}{/if}
    </div>
  {/if}
{/snippet}

{#if inline}
  <div class={["flex min-h-0 flex-col", className]}>
    <div class="flex shrink-0 items-center gap-2 border-b border-zinc-950/5 px-3 dark:border-white/8">
      <Icon name="magnifying-glass" class="fill-zinc-400 dark:fill-zinc-500" />
      <Input
        bare
        id={inputId}
        {name}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="{id}-list"
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={label}
        {placeholder}
        autocomplete="off"
        spellcheck="false"
        data-autofocus={autofocus || undefined}
        bind:value={query}
        oninput={() => (activeKey = undefined)}
        {onkeydown}
        class="min-w-0 flex-1"
        {@attach focusOnMount}
      />
    </div>
    {@render list()}
  </div>
{:else}
  <div class={["relative", className]}>
    <Input
      id={inputId}
      {name}
      type="text"
      role="combobox"
      aria-expanded={open}
      aria-controls="{id}-list"
      aria-autocomplete="list"
      aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
      aria-label={field ? undefined : label}
      aria-describedby={field?.describedBy}
      {placeholder}
      autocomplete="off"
      spellcheck="false"
      bind:value={query}
      oninput={() => {
        activeKey = undefined;
        typed = true;
        open = true;
      }}
      onclick={() => (open = !open)}
      onblur={() => {
        open = false;
        typed = false;
      }}
      onchange={() => onchange?.(query)}
      {onkeydown}
      class="pr-8"
      {@attach focusOnMount}
      {@attach (node: HTMLInputElement) => {
        input = node;
      }}
    />
    <Icon name="chevron-up-down" class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 fill-zinc-400 dark:fill-zinc-500" />
    <Popover bind:open label={label} role="none" anchor={input} placement="bottom-start" focusOnOpen={false} class="w-(--float-anchor-width) min-w-48">
      {@render list()}
    </Popover>
  </div>
{/if}
