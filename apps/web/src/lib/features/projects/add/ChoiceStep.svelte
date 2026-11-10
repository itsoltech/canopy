<script lang="ts" generics="T">
  import { moveActive, movementOf } from "#lib/features/commands/palette.ts";
  import {
    paletteEmptyClass,
    paletteGroupLabelClass,
    paletteInputClass,
    paletteListClass,
  } from "#lib/features/commands/palette-style.ts";
  import PaletteFooter from "#lib/features/commands/PaletteFooter.svelte";
  import PaletteOption from "#lib/features/commands/PaletteOption.svelte";
  import ConnectorIcon from "#lib/features/connectors/ConnectorIcon.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import type { Choice } from "./add-project-flow.ts";
  import StepHeader from "./StepHeader.svelte";

  /**
   * One list step of Add project: a search over its options under one group label. The first option that can
   * be chosen starts active; ↑↓ move, Enter chooses, Backspace on an empty search goes back.
   */
  let {
    label,
    placeholder,
    choices,
    onchoose,
    onback,
    onclose,
  }: {
    label: string;
    placeholder: string;
    choices: readonly Choice<T>[];
    onchoose: (value: T) => void;
    onback?: (() => void) | undefined;
    onclose: () => void;
  } = $props();

  const id = $props.id();
  let input = $state<HTMLInputElement>();
  let query = $state("");
  let activeKey = $state<string>();

  const shown = $derived(
    choices.filter((c) => `${c.title} ${c.detail ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())),
  );

  const activeIndex = $derived.by(() => {
    const index = shown.findIndex((c) => c.key === activeKey);

    return index >= 0 ? index : shown.findIndex((c) => !c.disabled);
  });

  const selected = $derived(shown[activeIndex]);

  function submit() {
    if (selected && !selected.disabled) onchoose(selected.value);
  }

  $effect(() => input?.focus());

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const movement = movementOf(event);

    if (movement) {
      event.preventDefault();
      activeKey = shown[moveActive(activeIndex, movement, shown.length)]?.key;
      document.getElementById(`${id}-${activeKey}`)?.scrollIntoView({ block: "nearest" });

      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      submit();

      return;
    }

    if (event.key === "Backspace" && query === "" && onback) {
      event.preventDefault();
      onback();
    }
  }
</script>

<StepHeader
  {onback}
  {onclose}
  onsubmit={submit}
  disabledReason={!selected || selected.disabled ? "Choose an available option." : undefined}
>
  <input
    bind:this={input}
    bind:value={query}
    name="add-project-search"
    type="text"
    role="combobox"
    aria-expanded="true"
    aria-controls="{id}-list"
    aria-autocomplete="list"
    aria-activedescendant={activeIndex >= 0 ? `${id}-${shown[activeIndex]?.key}` : undefined}
    aria-label={placeholder}
    {placeholder}
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    oninput={() => (activeKey = undefined)}
    {onkeydown}
    class={paletteInputClass}
  />
</StepHeader>

<div id="{id}-list" role="listbox" aria-label={label} class={paletteListClass}>
  <div role="presentation" class={paletteGroupLabelClass}>{label}</div>
  {#each shown as choice, index (choice.key)}
    {#snippet lead()}
      {#if choice.mark}<ConnectorIcon type={choice.mark} class="text-zinc-500 dark:text-zinc-400" />
      {:else}<StatusDot tone={choice.online ? "emerald" : "neutral"} class="mx-[0.3125rem]" />{/if}
    {/snippet}
    <PaletteOption
      id="{id}-{choice.key}"
      title={choice.title}
      detail={choice.detail}
      status={choice.status}
      icon={choice.icon}
      disabled={choice.disabled}
      active={index === activeIndex}
      onchoose={() => onchoose(choice.value)}
      onpoint={() => (activeKey = choice.key)}
      leading={choice.mark || choice.online !== undefined ? lead : undefined}
    />
  {/each}
  {#if shown.length === 0}<p class={paletteEmptyClass}>No results for “{query.trim()}”</p>{/if}
</div>

<PaletteFooter
  hints={[
    { hotkeys: ["ArrowUp", "ArrowDown"], label: "Navigate" },
    { hotkeys: ["Enter"], label: "Select" },
    ...(onback ? [{ hotkeys: ["Backspace"], label: "Back" }] : []),
    { hotkeys: ["Escape"], label: "Close" },
  ]}
/>
