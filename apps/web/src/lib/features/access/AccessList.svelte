<script lang="ts">
  import {
    ACCESS_SEARCH_THRESHOLD,
    accessMatches,
    accessToggled,
    accessWithAll,
    type AccessChoice,
  } from "@canopy/domain/access-picker";
  import ChoiceControl from "#lib/shared/ui/ChoiceControl.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import { listboxHeadingClasses } from "#lib/shared/ui/listbox.ts";
  import type { AccessOption } from "./access-options.ts";

  /**
   * Content of the access popover: an "All" switch (also ones added later), a search field for long lists and a
   * dense checklist. With "All" on the list stays in place, checked and dimmed, so nothing moves.
   */
  let {
    choice = $bindable(),
    options,
    noun,
    icon,
    allowAll = true,
  }: {
    choice: AccessChoice;
    options: readonly AccessOption[];
    /** Plural, lower case ("workers"). */
    noun: string;
    icon: IconName;
    allowAll?: boolean;
  } = $props();

  const id = $props.id();
  let query = $state("");
  const searchable = $derived(options.length > ACCESS_SEARCH_THRESHOLD);

  const shown = $derived(
    query.trim() ? options.filter((o) => accessMatches(query, o.name, o.group, o.detail)) : options,
  );

  const grouped = $derived(new Set(options.map((o) => o.group)).size > 1);
  const selectable = $derived(options.filter((o) => !o.readOnly).map((o) => o.id));
  const allOn = $derived(allowAll && choice.all);
  const chosen = $derived(choice.ids.filter((v) => options.some((o) => o.id === v)).length);
  const everyChosen = $derived(selectable.every((v) => choice.ids.includes(v)));

  function chooseEvery(on: boolean) {
    const kept = choice.ids.filter((v) => !selectable.includes(v));
    choice = { all: false, ids: on ? [...kept, ...selectable] : kept };
  }
</script>

<div class="flex max-h-[min(28rem,var(--float-available-height,28rem))] flex-col in-data-sheet:max-h-[70dvh]">
  {#if allowAll}
    <div class="flex shrink-0 items-center gap-3 border-b border-zinc-950/5 px-3 py-2 dark:border-white/8">
      <div class="min-w-0 flex-1">
        <p class="text-base/6 font-medium text-zinc-950 sm:text-sm/5 dark:text-white">All {noun}</p>
        <p class="text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">Includes {noun} added later.</p>
      </div>
      <Switch
        name="{id}-all"
        label="All {noun}"
        checked={choice.all}
        onchange={(all) => (choice = accessWithAll(choice, all, selectable))}
      />
    </div>
  {/if}
  {#if searchable}
    <div class="shrink-0 border-b border-zinc-950/5 p-1.5 dark:border-white/8">
      <SearchField name="{id}-search" label="Search {noun}" placeholder="Search {noun}" bind:value={query} />
    </div>
  {/if}
  <div
    role="group"
    aria-label={noun}
    class={[
      "min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1 transition-opacity duration-(--duration-fast) ease-smooth-out motion-reduce:transition-none",
      allOn && "opacity-50",
    ]}
  >
    {#each shown as option, index (option.id)}
      {#if grouped && option.group && option.group !== shown[index - 1]?.group}<p
          class={[listboxHeadingClasses, "px-2"]}
        >
          {option.group}
        </p>{/if}
      <label
        class="flex min-h-10 items-center gap-2 rounded-lg px-2 text-base/6 has-enabled:hover:bg-zinc-950/5 sm:min-h-8 sm:text-sm/5 dark:has-enabled:hover:bg-white/8"
      >
        <ChoiceControl
          name="{id}-{option.id}"
          disabled={allOn || !!option.readOnly}
          bind:checked={
            () => allOn || choice.ids.includes(option.id), (on) => (choice = accessToggled(choice, option.id, on))
          }
        />
        <Icon name={icon} class="shrink-0 fill-zinc-400 dark:fill-zinc-500" />
        <TruncatedText text={option.name} class="flex-1 text-zinc-950 dark:text-white" />
        {#if option.readOnly}<TruncatedText
            text="Read-only"
            hint={option.readOnly}
            class="shrink-0 text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400"
          />{:else if option.online !== undefined}<span
            class="flex shrink-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400"
            ><StatusDot tone={option.online ? "emerald" : "neutral"} />{option.online
              ? "Connected"
              : "Disconnected"}</span
          >{:else if option.detail}<TruncatedText
            text={option.detail}
            class="max-w-40 shrink text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400"
          />{/if}
      </label>
    {:else}
      <p class="px-2 py-2 text-base/6 text-zinc-500 sm:text-sm/5 dark:text-zinc-400">
        {query.trim() ? `No ${noun} match “${query.trim()}”.` : `No ${noun} yet.`}
      </p>
    {/each}
  </div>
  {#if selectable.length > 1}
    <div
      class="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-950/5 py-1 pr-1 pl-3 dark:border-white/8"
    >
      <p class="text-sm/5 text-zinc-500 tabular-nums sm:text-xs/4 dark:text-zinc-400">
        {allOn ? options.length : chosen} of {options.length} chosen
      </p>
      <Button size="sm" variant="ghost" disabled={allOn} onclick={() => chooseEvery(!everyChosen)}>
        {everyChosen ? "Clear all" : "Choose all"}
      </Button>
    </div>
  {/if}
</div>
