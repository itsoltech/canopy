<script lang="ts" generics="T">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Input from "./Input.svelte";
  import Icon from "./Icon.svelte";
  import { listboxOptionClasses } from "./listbox.ts";

  /** Single-line, ungrouped picker rows. Only the viewport and a small overscan enter the DOM. */
  let {
    items,
    key,
    text,
    value,
    query = $bindable(""),
    label,
    placeholder,
    onselect,
    option,
    empty,
    class: className,
  }: {
    items: readonly T[];
    key: (item: T) => string;
    text: (item: T) => string;
    value: string | undefined;
    query?: string;
    label: string;
    placeholder?: string | undefined;
    onselect: (item: T) => void;
    option?: Snippet<[T, { active: boolean; selected: boolean }]> | undefined;
    empty?: Snippet<[string]> | undefined;
    class?: ClassValue;
  } = $props();

  const id = $props.id();
  let viewport = $state<HTMLDivElement>();
  let height = $state(320);
  let top = $state(0);
  let rowHeight = $state(28);
  let activeKey = $state<string>();
  const words = $derived(query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean));

  const matched = $derived(
    items.filter((item) => words.every((word) => text(item).toLocaleLowerCase().includes(word))),
  );

  const activeIndex = $derived(
    Math.max(
      0,
      matched.findIndex((item) => key(item) === (activeKey ?? value)),
    ),
  );

  const start = $derived(Math.max(0, Math.floor(top / rowHeight) - 4));
  const end = $derived(Math.min(matched.length, Math.ceil((top + height) / rowHeight) + 4));

  $effect(() => {
    if (!viewport || !matched.length) return;
    const offset = activeIndex * rowHeight;

    if (offset < viewport.scrollTop) viewport.scrollTop = offset;
    else if (offset + rowHeight > viewport.scrollTop + height) viewport.scrollTop = offset + rowHeight - height;
    top = viewport.scrollTop;
  });

  function measure(node: HTMLElement) {
    const observer = new ResizeObserver(([entry]) => {
      const measured = entry?.borderBoxSize[0]?.blockSize;

      if (measured) rowHeight = measured;
    });

    observer.observe(node);

    return () => observer.disconnect();
  }

  function keyboard(event: KeyboardEvent) {
    if (event.isComposing) return;

    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      query = "";

      return;
    }

    if (event.key === "Enter" && matched[activeIndex]) {
      event.preventDefault();
      onselect(matched[activeIndex]);

      return;
    }

    const steps = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 };
    const step = Object.entries(steps).find(([name]) => name === event.key)?.[1];

    if (step === undefined || !matched.length) return;
    event.preventDefault();
    const next = (((activeIndex + step) % matched.length) + matched.length) % matched.length;
    activeKey = key(matched[next]!);
  }
</script>

<div
  class={[
    "relative flex min-h-0 flex-1 flex-col [--picker-row-height:2.5rem] sm:[--picker-row-height:1.75rem] pointer-coarse:[--picker-row-height:2.75rem]",
    className,
  ]}
>
  <div aria-hidden="true" class="pointer-events-none absolute h-(--picker-row-height) w-0" {@attach measure}></div>
  <div class="flex shrink-0 items-center gap-2 border-b border-zinc-950/5 px-2.5 dark:border-white/8">
    <Icon name="magnifying-glass" class="fill-zinc-400 dark:fill-zinc-500" />
    <Input
      bare
      name="font-search"
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls="{id}-list"
      aria-autocomplete="list"
      aria-activedescendant={matched.length ? `${id}-${activeIndex}` : undefined}
      aria-label={label}
      {placeholder}
      autocomplete="off"
      spellcheck="false"
      data-autofocus
      bind:value={query}
      oninput={() => {
        activeKey = undefined;
        if (viewport) viewport.scrollTop = 0;
        top = 0;
      }}
      onkeydown={keyboard}
      class="min-w-0 flex-1"
      {@attach (node) => node.focus()}
    />
  </div>
  <div
    data-listbox-scroll
    bind:this={viewport}
    bind:clientHeight={height}
    onscroll={() => (top = viewport?.scrollTop ?? 0)}
    class="min-h-0 flex-1 scroll-py-1 scroll-stable overflow-y-auto overscroll-contain"
  >
    <ul id="{id}-list" role="listbox" aria-label={label} class="grid grid-cols-1 content-start px-1.5 py-1">
      <li role="presentation" style:height="{start * rowHeight}px"></li>
      {#each matched.slice(start, end) as item, offset (key(item))}
        {@const index = start + offset}
        {@const selected = key(item) === value}
        <!-- Focus stays in the input; aria-activedescendant provides keyboard navigation. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id="{id}-{index}"
          role="option"
          aria-selected={selected}
          aria-posinset={index + 1}
          aria-setsize={matched.length}
          data-active={index === activeIndex || undefined}
          class={[listboxOptionClasses, "flex h-(--picker-row-height) flex-col justify-center"]}
          onpointerdown={(event) => event.preventDefault()}
          onpointermove={() => (activeKey = key(item))}
          onclick={() => onselect(item)}
        >
          {#if option}{@render option(item, { active: index === activeIndex, selected })}{:else}<p class="truncate">
              {text(item)}
            </p>{/if}
        </li>
      {/each}
      <li role="presentation" style:height="{Math.max(0, matched.length - end) * rowHeight}px"></li>
    </ul>
    {#if !matched.length}<div role="status" class="px-4 py-6 text-center text-sm/5 text-zinc-500 dark:text-zinc-400">
        {#if empty}{@render empty(query)}{:else}No matches{/if}
      </div>{/if}
  </div>
</div>
