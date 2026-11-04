<script lang="ts" generics="T extends { value: string; label: string }">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** One tab stop, wrapping arrow navigation; vertical arrows follow the rendered grid columns. */
  let {
    label,
    options,
    value,
    onchange,
    disabled = false,
    class: className,
    children,
  }: {
    label: string;
    options: readonly T[];
    value: string;
    onchange: (value: string) => void;
    disabled?: boolean;
    class?: ClassValue;
    children: Snippet<[T, boolean]>;
  } = $props();

  const selected = $derived(
    Math.max(
      0,
      options.findIndex((o) => o.value === value),
    ),
  );

  function navigate(event: KeyboardEvent & { currentTarget: HTMLButtonElement }, index: number) {
    const button = event.currentTarget;
    const group = button.parentElement!;
    const columns = getComputedStyle(group).gridTemplateColumns.split(" ").length;

    const delta = new Map<string, number>([
      ["ArrowRight", 1],
      ["ArrowLeft", -1],
      ["ArrowDown", columns],
      ["ArrowUp", -columns],
    ]);

    let next: number;

    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else {
      const step = delta.get(event.key);

      if (step === undefined) return;
      next = (index + step + options.length) % options.length;
    }

    event.preventDefault();
    const option = options[next];

    if (!option || disabled) return;
    onchange(option.value);
    group.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  }
</script>

<div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} class={["grid gap-1.5", className]}>
  {#each options as option, index (option.value)}
    <button
      type="button"
      role="radio"
      aria-checked={value === option.value}
      aria-label={option.label}
      title={option.label}
      tabindex={index === selected ? 0 : -1}
      {disabled}
      class="grid min-h-11 min-w-0 place-items-center rounded-lg p-1 focus-ring hover:bg-zinc-950/5 disabled:opacity-50 aria-checked:bg-zinc-950/5 dark:hover:bg-white/5 dark:aria-checked:bg-white/10"
      onclick={() => onchange(option.value)}
      onkeydown={(event) => navigate(event, index)}
    >
      {@render children(option, value === option.value)}
    </button>
  {/each}
</div>
