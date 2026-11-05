<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import AccentDot from "./AccentDot.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { instanceTitle, type PickerInstance } from "./picker-instances.ts";
  import ProviderIcon from "./ProviderIcon.svelte";

  /**
   * The model picker's rail: Favorites, then one tab per provider instance. Instances of one provider share
   * its mark; the instance's accent dot and its name in the tooltip tell them apart. Scrolls when long (the
   * pressed tab stays in view). Up/Down, Home/End move between tabs.
   */
  let {
    instances,
    current,
    searching,
    onpick,
    class: className,
  }: {
    instances: readonly PickerInstance[];
    /** "favorites" or the key of the instance in view. */
    current: string;
    /** A search shows every instance: no tab is pressed. */
    searching: boolean;
    onpick: (target: string) => void;
    class?: ClassValue;
  } = $props();

  const targets = $derived(["favorites", ...instances.map((i) => i.key)]);

  function onkeydown(event: KeyboardEvent) {
    const index = targets.indexOf(current);

    const next =
      event.key === "ArrowDown"
        ? (index + 1) % targets.length
        : event.key === "ArrowUp"
          ? (index - 1 + targets.length) % targets.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? targets.length - 1
              : -1;

    if (next < 0) return;
    event.preventDefault();
    onpick(targets[next]!);
    const rail = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    rail?.querySelectorAll("button")[next]?.focus();
  }

  const keepInView = (pressed: boolean) => (node: HTMLElement) => {
    if (pressed) node.scrollIntoView({ block: "nearest" });
  };
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  role="group"
  aria-label="Show models"
  class={[
    "flex shrink-0 [scrollbar-width:none] flex-col items-center gap-0.5 overflow-y-auto overscroll-contain border-r border-zinc-950/5 p-1 dark:border-white/8",
    className,
  ]}
  {onkeydown}
>
  {#snippet tab(target: string, label: string, instance: PickerInstance | undefined)}
    {@const pressed = !searching && current === target}
    <button
      type="button"
      class="relative grid size-9 shrink-0 place-items-center rounded-lg focus-ring hover:bg-zinc-950/5 aria-pressed:bg-zinc-950/6 sm:size-7 dark:hover:bg-white/5 dark:aria-pressed:bg-white/10"
      aria-label={label}
      aria-pressed={pressed}
      onclick={() => onpick(target)}
      {@attach tooltip(label, { placement: "right" })}
      {@attach keepInView(pressed)}
    >
      {#if !instance}
        <Icon name="star" class={pressed ? "text-amber-500" : "fill-zinc-400 dark:fill-zinc-500"} />
      {:else}
        <ProviderIcon provider={instance.provider} class={pressed ? undefined : "opacity-60 grayscale"} />
        {#if instance.shared}
          <AccentDot accent={instance.accent} class="absolute right-1 bottom-1 size-2 ring-2 ring-surface" />
        {/if}
      {/if}
    </button>
  {/snippet}
  {@render tab("favorites", "Favorites", undefined)}
  {#each instances as instance (instance.key)}{@render tab(instance.key, instanceTitle(instance), instance)}{/each}
</div>
