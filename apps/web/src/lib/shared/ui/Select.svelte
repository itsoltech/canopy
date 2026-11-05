<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";
  import { useField } from "./field.ts";
  import Icon from "./Icon.svelte";
  import Popover from "./Popover.svelte";
  import TouchTarget from "./TouchTarget.svelte";
  import TruncatedText from "./TruncatedText.svelte";
  import PickerTrigger from "./PickerTrigger.svelte";
  import {
    listboxHeadingClasses,
    listboxOptionClasses,
    moveOption,
    selectedIndex,
    selectTypeahead,
    type SelectOption,
  } from "./listbox.ts";

  /** Select-only combobox: navigation previews; Enter/Space/Tab commit, Escape cancels.
   * Focus stays on the trigger. `class` belongs to the wrapper, never the control. */
  type Props = Omit<HTMLButtonAttributes, "class" | "value" | "onchange" | "children" | "type"> & {
    class?: ClassValue;
    value?: unknown;
    options: readonly SelectOption[];
    onchange?: (value: string) => void;
    name?: string;
    required?: boolean;
    placeholder?: string;
  };

  let {
    class: className,
    value = $bindable(),
    options,
    onchange,
    name,
    required,
    placeholder = "Choose…",
    disabled,
    form,
    id: explicitId,
    onkeydown: extraKeydown,
    ...rest
  }: Props = $props();

  const field = useField();
  const uid = $props.id();
  const id = $derived(explicitId ?? field?.id ?? `${uid}-trigger`);
  const selected = $derived(options.find((option) => option.value === value));

  const groups = $derived.by(() => {
    const groups: { label: string | undefined; entries: { option: SelectOption; index: number }[] }[] = [];
    options.forEach((option, index) => {
      const last = groups.at(-1);

      if (last && last.label === option.group && !option.separator) last.entries.push({ option, index });
      else groups.push({ label: option.group, entries: [{ option, index }] });
    });

    return groups;
  });

  let open = $state(false);
  let active = $state(-1);
  let button = $state<HTMLButtonElement>();
  let typeahead = selectTypeahead();
  const optionId = (index: number) => `${uid}-option-${index}`;

  $effect(() => {
    if (!open || !options[active] || options[active]?.disabled) active = selectedIndex(options, selected?.value);
  });

  $effect(() => {
    if (disabled) open = false;
  });

  $effect(() => {
    if (!open) typeahead = selectTypeahead();
  });

  $effect(() => {
    if (open && active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  });

  $effect(() => {
    const initial = untrack(() => value);
    const owner = button?.form;

    const reset = () => {
      value = initial;
      open = false;
    };

    owner?.addEventListener("reset", reset);

    return () => owner?.removeEventListener("reset", reset);
  });

  function choose(index: number) {
    const option = options[index];

    if (!option || option.disabled || button?.matches(":disabled")) return;
    const changed = value !== option.value;
    value = option.value;
    open = false;

    if (changed) onchange?.(option.value);
    button?.focus({ preventScroll: true });
  }

  function keyboard(event: KeyboardEvent & { currentTarget: EventTarget & HTMLButtonElement }) {
    extraKeydown?.(event);

    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || disabled) return;
    const wasOpen = open;

    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        open = true;

        if (wasOpen) active = moveOption(options, active, event.key === "ArrowDown" ? 1 : -1);

        return;
      case "Home":
      case "End":
        event.preventDefault();
        open = true;
        active =
          event.key === "Home" ? options.findIndex((o) => !o.disabled) : options.findLastIndex((o) => !o.disabled);

        return;
      case "Enter":
      case " ":
        event.preventDefault();

        if (wasOpen) choose(active);
        else open = true;

        return;
      case "Escape":
        if (wasOpen) {
          event.preventDefault();
          event.stopPropagation();
          open = false;
        }

        return;
      case "Tab":
        if (wasOpen) {
          choose(active);
          open = false;
        }

        return;
    }

    if (event.key.length === 1 && !event.altKey) {
      event.preventDefault();
      active = typeahead(options, wasOpen ? active : selectedIndex(options, selected?.value), event.key);
      open = true;
    }
  }
</script>

<div class={className}>
  <input type="hidden" {name} {form} {disabled} value={value == null ? "" : String(value)} />
  {#if required}
    <input
      class="sr-only"
      type="text"
      tabindex="-1"
      aria-hidden="true"
      value={selected?.value ?? ""}
      required
      {disabled}
      {form}
      oninvalid={(event) => {
        event.preventDefault();
        button?.focus();
      }}
    />
  {/if}
  <Popover
    bind:open
    label={rest["aria-label"] ?? name ?? "Options"}
    role="none"
    sheet
    focusOnOpen={false}
    class={[
      "w-(--float-anchor-width) max-w-[calc(100vw-1rem)]",
      options.some((option) => option.description) ? "min-w-72" : "min-w-48",
    ]}
  >
    {#snippet trigger(props)}
      <PickerTrigger
        {...props}
        {...rest}
        bind:element={button}
        {id}
        {disabled}
        {form}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="{uid}-list"
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
        aria-invalid={rest["aria-invalid"] ?? (field?.invalid || undefined)}
        aria-required={required || undefined}
        onkeydown={keyboard}
        text={selected?.label ?? placeholder}
        leadingIcon={selected?.icon}
        icon="chevron-up-down"
      />
    {/snippet}
    <ul
      id="{uid}-list"
      role="listbox"
      aria-label={rest["aria-label"] ?? name ?? "Options"}
      class="grid grid-cols-1 gap-0.5 px-1"
    >
      {#each groups as group, groupIndex (groupIndex)}
        {#if groupIndex > 0}
          <li role="presentation" class="mx-2 my-1 h-px bg-zinc-950/5 dark:bg-white/10"></li>
        {/if}
        <li role={group.label ? "group" : "presentation"} aria-label={group.label}>
          {#if group.label}<div class={[listboxHeadingClasses, "-mx-1 px-3"]}>{group.label}</div>{/if}
          <ul role="presentation" class="grid grid-cols-1 gap-0.5">
            {#each group.entries as { option, index } (option.value)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <li
                id={optionId(index)}
                role="option"
                aria-label={option.label}
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                aria-describedby={option.description ? `${optionId(index)}-description` : undefined}
                data-active={active === index || undefined}
                class={[
                  listboxOptionClasses,
                  "relative flex items-center gap-2 pointer-coarse:min-h-11",
                  option.disabled && "opacity-40",
                ]}
                onpointerdown={(event) => event.preventDefault()}
                onpointermove={() => {
                  if (!option.disabled) active = index;
                }}
                onclick={() => choose(index)}
              >
                {#if option.icon}<Icon name={option.icon} />{/if}
                <div class="min-w-0 flex-1">
                  <TruncatedText text={option.label} />
                  {#if option.description}<p
                      id="{optionId(index)}-description"
                      class="text-sm/5 text-pretty text-zinc-500 sm:text-xs/4 dark:text-zinc-400"
                    >
                      {option.description}
                    </p>{/if}
                </div>
                <Icon
                  name="check"
                  class={["text-brand-600 dark:text-brand-400", option.value !== value && "invisible"]}
                />
                <TouchTarget />
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  </Popover>
</div>
