<script lang="ts" generics="T">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Combobox from "./Combobox.svelte";
  import VirtualCombobox from "./VirtualCombobox.svelte";
  import type { Placement } from "./floating.ts";
  import Popover, { type PopoverTriggerProps } from "./Popover.svelte";

  /**
   * A pill that opens a searchable list (a bottom sheet on phones): a popover with an inline `Combobox`
   * and an optional footer link. Choosing an item closes it and gives focus back to the pill.
   *
   *   <SearchPicker label="Choose a project" items={projects} key={(p) => p.id} text={(p) => p.name} value={id} onselect={pick}>
   *     {#snippet trigger(props)}<PillButton {...props}>…</PillButton>{/snippet}
   *     {#snippet option(p, state)}…{/snippet}
   *   </SearchPicker>
   */
  let {
    items,
    key,
    text,
    value,
    onselect,
    label,
    searchLabel,
    placeholder,
    open = $bindable(false),
    placement = "bottom-start",
    groupOf,
    disabled,
    class: className,
    trigger,
    option,
    empty,
    link,
    footer,
    query = $bindable(""),
    virtual = false,
  }: {
    items: readonly T[];
    key: (item: T) => string;
    /** What the search matches. */
    text: (item: T) => string;
    /** Key of the current item. */
    value: string | undefined;
    onselect: (item: T) => void;
    /** Accessible name of the panel. */
    label: string;
    /** Accessible name of the search field (default: `label`). */
    searchLabel?: string | undefined;
    placeholder?: string | undefined;
    open?: boolean;
    placement?: Placement;
    groupOf?: ((item: T) => string | undefined) | undefined;
    disabled?: ((item: T) => boolean) | undefined;
    /** Width of the panel (it is full width as a sheet). */
    class?: ClassValue;
    trigger: Snippet<[PopoverTriggerProps]>;
    option?: Snippet<[T, { active: boolean; selected: boolean }]> | undefined;
    empty?: Snippet<[string]> | undefined;
    /** A link in the footer (where the list is managed). */
    link?: { href: string; label: string } | undefined;
    footer?: Snippet | undefined;
    query?: string;
    /** Single-line ungrouped lists; grouped/disabled lists use the standard Combobox. */
    virtual?: boolean;
  } = $props();
</script>

<Popover
  bind:open
  {label}
  {placement}
  sheet
  onclose={() => (query = "")}
  class={["w-[min(22rem,calc(100vw-1rem))]", className]}
  {trigger}
>
  <div class="flex max-h-[min(24rem,var(--float-available-height,24rem))] flex-col in-data-sheet:max-h-[70dvh]">
    {#if virtual && !groupOf && !disabled}
      <VirtualCombobox
        {items}
        {key}
        {text}
        {value}
        bind:query
        label={searchLabel ?? label}
        {placeholder}
        {option}
        {empty}
        onselect={(item) => {
          onselect(item);
          open = false;
        }}
      />
    {:else}<Combobox
        inline
        autofocus
        {items}
        {key}
        {text}
        {groupOf}
        {disabled}
        bind:query
        {value}
        label={searchLabel ?? label}
        {placeholder}
        onselect={(item) => {
          onselect(item);
          open = false;
        }}
        class="min-h-0 flex-1"
        {option}
        {empty}
      />{/if}
    {#if footer}<div class="shrink-0 border-t border-zinc-950/5 p-2 dark:border-white/8">{@render footer()}</div>{/if}
    {#if link}
      <div class="flex shrink-0 border-t border-zinc-950/5 py-1 pr-1 pl-2.5 text-sm/5 sm:text-xs/4 dark:border-white/8">
        <a
          href={link.href}
          class="min-w-0 flex-1 truncate py-1 font-medium text-zinc-700 focus-ring hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
          >{link.label}</a
        >
      </div>
    {/if}
  </div>
</Popover>
