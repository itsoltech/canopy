<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { ClassValue } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { listboxHeadingClasses, listboxOptionClasses } from "#lib/shared/ui/listbox.ts";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { kindLook, safeIcon } from "./kinds.ts";
  import type { MentionOption } from "./sources.svelte.ts";

  /**
   * The mention popup's list (WAI-ARIA listbox driven from the editor: focus stays in the text, arrows move
   * `active`, Enter or Tab chooses). Grouped by kind with sticky headings; each row has the kind's icon (or the
   * plugin's), the name with the typed characters highlighted, and a line about it. Touch: a tap chooses.
   */
  let {
    id,
    label,
    options,
    active,
    loading,
    error,
    empty,
    onchoose,
    onactive,
    optionIcon,
    class: className,
  }: {
    id: string;
    label: string;
    options: readonly MentionOption[];
    active: number;
    loading: boolean;
    error: string | undefined;
    /** Shown when nothing matches (says what this trigger lists). */
    empty: string;
    onchoose: (option: MentionOption) => void;
    onactive: (index: number) => void;
    optionIcon?: Snippet<[MentionOption]>;
    class?: ClassValue;
  } = $props();

  let press: { pointerId: number; x: number; y: number; moved: boolean } | undefined;
  function preserveFocus(event: PointerEvent) {
    event.preventDefault();
    press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  }
  function trackPress(event: PointerEvent) {
    if (press?.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) press.moved = true;
  }
  function pick(event: PointerEvent, option: MentionOption) {
    trackPress(event);
    const tap = press?.pointerId === event.pointerId && !press.moved;
    press = undefined;
    // WebKit may suppress click after a cancelled pointerdown. Movement disqualifies a
    // swipe even when the browser sends pointerup instead of pointercancel.
    if (event.button === 0 && tap) { event.preventDefault(); onchoose(option); }
  }

  const groups = $derived.by(() => {
    const out: { label: string; entries: { option: MentionOption; index: number }[] }[] = [];
    options.forEach((option, index) => {
      const last = out.at(-1);
      if (last?.label === option.group) last.entries.push({ option, index });
      else out.push({ label: option.group, entries: [{ option, index }] });
    });
    return out;
  });

  $effect(() => {
    if (active < 0) return;
    if (active === 0) document.getElementById(`${id}-list`)?.closest<HTMLElement>("[data-mention-scroll], [popover]")?.scrollTo({ top: 0 });
    else document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  });

  /** The title split into plain and matched runs. */
  function runs(title: string, indices: readonly number[]): { text: string; hit: boolean }[] {
    const hits = new Set(indices);
    const out: { text: string; hit: boolean }[] = [];
    [...title].forEach((ch, i) => {
      const hit = hits.has(i);
      const last = out.at(-1);
      if (last && last.hit === hit) last.text += ch;
      else out.push({ text: ch, hit });
    });
    return out;
  }
</script>

<div class={className}>
<ul id="{id}-list" role="listbox" aria-label={label} class="grid grid-cols-1 content-start p-1" onpointerdown={preserveFocus} onpointermove={trackPress} onpointercancel={() => { press = undefined; }}>
  {#each groups as group (group.label)}
    <li role="presentation" class={[listboxHeadingClasses, "-mx-1 px-3.5"]}>
      <div class="truncate">{group.label}</div>
    </li>
    {#each group.entries as { option, index } (option.key)}
      {@const icon = safeIcon(option.data.icon)}
      <!-- Keys reach options through the editor (aria-activedescendant); a tap or click picks with the pointer. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <li
        id="{id}-option-{index}"
        role="option"
        aria-selected={index === active}
        data-active={index === active || undefined}
        class={["flex items-start gap-2.5", listboxOptionClasses]}
        onpointermove={(event) => { if (event.pointerType !== "touch") onactive(index); }}
        onpointerup={(event) => pick(event, option)}
        onclick={(event) => { if (event.detail === 0) onchoose(option); }}
      >
        <div class="flex h-lh shrink-0 items-center">
          {#if optionIcon}
            {@render optionIcon(option)}
          {:else if icon}
            <!-- Harness icons are often dark glyphs on transparency: in dark mode they sit on a light tile to stay visible. -->
            <img src={icon} alt="" class="size-4 rounded-sm object-contain dark:bg-zinc-200 dark:p-px" />
          {:else}
            <Icon name={kindLook(option.data).icon} class="fill-brand-600 dark:fill-brand-400" />
          {/if}
        </div>
        <div class="grid min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-2">
          <p class="truncate font-medium sm:shrink-0 sm:basis-auto sm:max-w-1/2">
            {#each runs(option.title, option.indices) as run, r (r)}{#if run.hit}<mark class="bg-transparent text-brand-700 dark:text-brand-300">{run.text}</mark>{:else}{run.text}{/if}{/each}
          </p>
          {#if option.detail}
            <p class="min-w-0 truncate text-sm/5 text-zinc-500 sm:flex-1 sm:text-xs/4 dark:text-zinc-400" title={option.detail}>{option.detail}</p>
          {/if}
        </div>
      </li>
    {/each}
  {/each}
</ul>
{#if loading && options.length === 0}
  <p class="flex items-center gap-2 px-4 py-3 text-sm/5 text-zinc-500 dark:text-zinc-400" role="status"><Spinner class="size-3.5" />Loading…</p>
{:else if error}
  <p class="flex items-start gap-2 px-4 py-3 text-sm/5 text-zinc-600 dark:text-zinc-300" role="status">
    <span class="flex h-lh shrink-0 items-center"><Icon name="signal-slash" class="fill-zinc-400 dark:fill-zinc-500" /></span>{error}
  </p>
{:else if options.length === 0}
  <p class="px-4 py-3 text-sm/5 text-zinc-500 dark:text-zinc-400" role="status">{empty}</p>
{/if}
</div>
