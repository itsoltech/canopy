<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  let {
    title,
    description,
    selected,
    onclick,
    disabled,
    class: className,
  }: {
    title: string;
    description: string;
    selected: boolean;
    onclick: () => void;
    disabled: boolean;
    class?: ClassValue;
  } = $props();
</script>

<button
  type="button"
  {onclick}
  {disabled}
  aria-pressed={selected}
  class={[
    "grid min-w-0 content-start gap-1 rounded-xl p-4 text-left text-base/6 ring-1 ring-zinc-950/10 focus-ring hover:bg-zinc-950/3 disabled:opacity-60 aria-pressed:bg-zinc-950/3 aria-pressed:ring-2 aria-pressed:ring-brand-500 sm:text-sm/6 dark:ring-white/10 dark:hover:bg-white/5 dark:aria-pressed:bg-white/5 dark:aria-pressed:ring-brand-500",
    className,
  ]}
>
  <p class="font-medium text-zinc-950 dark:text-white">{title}</p>
  <p class="text-pretty text-zinc-500 dark:text-zinc-400">{description}</p>
</button>
