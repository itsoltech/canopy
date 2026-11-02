<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";
  import { controlClasses, useField } from "./field.ts";
  import Icon from "./Icon.svelte";
  import Popover from "./Popover.svelte";
  import TouchTarget from "./TouchTarget.svelte";
  import { listboxHeadingClasses, listboxOptionClasses, moveOption, selectedIndex, selectTypeahead, type SelectOption } from "./listbox.ts";

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
  let { class: className, value = $bindable(), options, onchange, name, required, placeholder = "Choose…", disabled, form, id: explicitId,
    onkeydown: extraKeydown, ...rest }: Props = $props();
  const field = useField();
  const uid = $props.id();
  const id = $derived(explicitId ?? field?.id ?? `${uid}-trigger`);
  const selected = $derived(options.find((option) => option.value === value));
  let open = $state(false);
  let active = $state(-1);
  let button = $state<HTMLButtonElement>();
  const typeahead = selectTypeahead();
  const optionId = (index: number) => `${uid}-option-${index}`;

  $effect(() => {
    if (!open || !options[active] || options[active]?.disabled) active = selectedIndex(options, value);
  });
  $effect(() => { if (disabled) open = false; });
  $effect(() => {
    if (open && active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  });
  $effect(() => {
    const initial = untrack(() => value);
    const owner = button?.form;
    const reset = () => { value = initial; open = false; };
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
      case "ArrowDown": case "ArrowUp":
        event.preventDefault(); open = true;
        if (wasOpen) active = moveOption(options, active, event.key === "ArrowDown" ? 1 : -1);
        return;
      case "Home": case "End":
        event.preventDefault(); open = true;
        active = event.key === "Home" ? options.findIndex((o) => !o.disabled) : options.findLastIndex((o) => !o.disabled);
        return;
      case "Enter": case " ":
        event.preventDefault();
        if (wasOpen) choose(active); else open = true;
        return;
      case "Escape":
        if (wasOpen) { event.preventDefault(); event.stopPropagation(); open = false; }
        return;
      case "Tab":
        if (wasOpen) choose(active);
        return;
    }
    if (event.key.length === 1 && !event.altKey) {
      event.preventDefault();
      active = typeahead(options, wasOpen ? active : selectedIndex(options, value), event.key);
      open = true;
    }
  }
</script>

<div class={className}>
  <input type="hidden" {name} {form} {disabled} value={value == null ? "" : String(value)} />
  {#if required}
    <input class="sr-only" type="text" tabindex="-1" aria-label={rest["aria-label"] ?? name ?? "Selection"} value={selected?.value ?? ""} required {disabled} {form}
      oninvalid={(event) => { event.preventDefault(); button?.focus(); }} />
  {/if}
  <Popover bind:open label={rest["aria-label"] ?? name ?? "Options"} role="none" sheet focusOnOpen={false} class="w-(--float-anchor-width) min-w-48 max-w-[calc(100vw-1rem)]">
    {#snippet trigger(props)}
      <button {...props} {...rest} bind:this={button} {id} type="button" {disabled} {form}
        role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls="{uid}-list"
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
        aria-invalid={rest["aria-invalid"] ?? (field?.invalid || undefined)} aria-required={required || undefined}
        onkeydown={keyboard}
        class={[controlClasses, "relative flex items-center gap-2 text-left pointer-coarse:min-h-12"]}>
        {#if selected?.icon}<Icon name={selected.icon} />{/if}
        <span class="min-w-0 flex-1 truncate">{selected?.label ?? placeholder}</span>
        <Icon name="chevron-up-down" class="fill-zinc-500 dark:fill-zinc-400" />
        <TouchTarget />
      </button>
    {/snippet}
    <ul id="{uid}-list" role="listbox" aria-label={rest["aria-label"] ?? name ?? "Options"} class="grid gap-0.5 p-1">
      {#each options as option, index (option.value)}
        {#if index > 0 && (option.separator || option.group !== options[index - 1]?.group)}
          <li role="presentation" class="mx-2 my-1 h-px bg-zinc-950/5 dark:bg-white/10"></li>
        {/if}
        {#if option.group && option.group !== options[index - 1]?.group}
          <li role="presentation" class={[listboxHeadingClasses, "px-2.5"]}>{option.group}</li>
        {/if}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li id={optionId(index)} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
          aria-describedby={option.description ? `${optionId(index)}-description` : undefined}
          data-active={active === index || undefined}
          class={[listboxOptionClasses, "relative flex items-center gap-2.5 pointer-coarse:min-h-12", option.disabled && "opacity-40"]}
          onpointerdown={(event) => event.preventDefault()}
          onpointermove={() => { if (!option.disabled) active = index; }} onclick={() => choose(index)}>
          {#if option.icon}<Icon name={option.icon} />{/if}
          <div class="min-w-0 flex-1">
            <div class="wrap-anywhere">{option.label}</div>
            {#if option.description}<p id="{optionId(index)}-description" class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">{option.description}</p>{/if}
          </div>
          <Icon name="check" class={["fill-brand-600 dark:fill-brand-400", option.value !== value && "invisible"]} />
          <TouchTarget />
        </li>
      {/each}
    </ul>
  </Popover>
</div>
