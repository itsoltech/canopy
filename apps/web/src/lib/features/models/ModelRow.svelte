<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Kbd from "#lib/shared/ui/Kbd.svelte";
  import { duration } from "#lib/shared/ui/motion.ts";
  import { providerName, type ModelOption } from "./catalog.ts";

  /**
   * One model in the picker's list: its concrete name, favorite shortcut, star and selection check.
   * A custom model reads "Use “…” with …".
   * The star shows on the active row only (always on touch screens and when starred).
   */
  let {
    option,
    active,
    selected,
    starred,
    shortcut,
    onstar,
    class: className,
  }: {
    option: ModelOption;
    active: boolean;
    selected: boolean;
    starred: boolean;
    /** Hotkey of a favorite (`Mod+1`). */
    shortcut?: string | undefined;
    onstar: () => void;
    class?: ClassValue;
  } = $props();

  // Starring fades the star in (motion.css `t-pop`).
  let popping = $state(false);
  let popped: ReturnType<typeof setTimeout> | undefined;

  function pop() {
    popping = true;
    clearTimeout(popped);
    popped = setTimeout(() => (popping = false), duration("medium"));
  }

  $effect(() => () => clearTimeout(popped));
</script>

<div class={["flex items-center gap-2", className]}>
  {#if option.origin === "custom"}
    <Icon name="plus" class="fill-zinc-500 dark:fill-zinc-400" />
    <span class="min-w-0 flex-1 truncate"
      >Use “{option.model}”
      <span class="text-zinc-500 dark:text-zinc-400">with {providerName(option.provider)} · {option.profileName}</span
      ></span
    >
  {:else}
    <span
      class="min-w-0 flex-1 font-medium [overflow-wrap:anywhere] whitespace-normal"
      title={option.model || undefined}>{option.name}</span
    >
    {#if shortcut}<Kbd hotkey={shortcut} />{/if}
    <IconButton
      icon="star"
      size="sm"
      tabindex={-1}
      label={starred
        ? `Remove ${option.name} (${option.profileName}) from favorites`
        : `Add ${option.name} (${option.profileName}) to favorites`}
      aria-pressed={starred}
      class={popping ? "t-pop" : undefined}
      iconClass={starred ? "text-amber-500" : ["fill-zinc-300 dark:fill-zinc-600", !active && "pointer-fine:invisible"]}
      onclick={(event) => {
        event.stopPropagation();
        if (!starred) pop();
        onstar();
      }}
    />
    <Icon name="check" class={["text-brand-600 dark:text-brand-400", !selected && "invisible"]} />
  {/if}
</div>
