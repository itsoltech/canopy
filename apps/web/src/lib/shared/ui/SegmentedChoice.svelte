<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { segmentedItem, segmentedTrack } from "./segmented.ts";

  /** One of a few options as a segmented control; arrow keys, Home and End move the choice. */

  let {
    label,
    value = $bindable(""),
    options,
    disabled = false,
    class: className,
  }: {
    label: string;
    value?: string;
    options: readonly { value: string; label: string }[];
    disabled?: boolean;
    class?: ClassValue;
  } = $props();

  function keydown(event: KeyboardEvent & { currentTarget: HTMLElement }) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];

    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const current = options.findIndex((o) => o.value === value);

    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;

    value = options[next]!.value;
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }
</script>

<div role="group" aria-label={label} class={["inline-flex w-fit max-w-full", segmentedTrack, className]}>
  {#each options as option (option.value)}
    <button
      type="button"
      {disabled}
      aria-pressed={value === option.value}
      data-active={value === option.value || undefined}
      onclick={() => (value = option.value)}
      onkeydown={keydown}
      class={[segmentedItem, "shrink-0 whitespace-nowrap"]}>{option.label}</button
    >
  {/each}
</div>
