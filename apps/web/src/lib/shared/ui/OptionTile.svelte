<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";

  /** Drawn radio tile. The enclosing radiogroup owns the accessible label and arrow-key order. */
  let {
    checked,
    label,
    onchange,
    children,
    class: className,
  }: {
    checked: boolean;
    label: string;
    onchange: () => void;
    children: Snippet;
    class?: ClassValue;
  } = $props();

  function navigate(event: KeyboardEvent) {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];

    if (!keys.includes(event.key)) return;

    if (!(event.currentTarget instanceof HTMLButtonElement)) return;
    const group = event.currentTarget.closest('[role="radiogroup"]');
    const options = [...(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const index = options.indexOf(event.currentTarget);

    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;

    event.preventDefault();
    options[next]?.focus();
    options[next]?.click();
  }
</script>

<button
  type="button"
  role="radio"
  aria-label={label}
  aria-checked={checked}
  tabindex={checked ? 0 : -1}
  onclick={onchange}
  onkeydown={navigate}
  class={[
    "relative min-h-(--settings-target) min-w-0 cursor-pointer overflow-hidden rounded-xl bg-surface text-left text-base/6 text-ink ring-1 ring-divider focus-ring hover:ring-accent aria-checked:ring-2 aria-checked:ring-accent sm:text-sm/6 forced-colors:aria-checked:outline-2",
    className,
  ]}
>
  {@render children()}
  {#if checked}
    <span
      class="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-action text-on-accent"
      aria-hidden="true"><Icon name="check" tone="inherit" /></span
    >
  {/if}
</button>
