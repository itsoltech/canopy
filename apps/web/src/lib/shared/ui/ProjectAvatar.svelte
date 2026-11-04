<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** Two-letter project mark with a colour derived from the name (stable across sessions). Decorative. */
  let { name, class: className }: { name: string; class?: ClassValue } = $props();

  const tones = [
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    "bg-rose-500/15 text-rose-700 dark:text-rose-400",
    "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    "bg-sky-500/15 text-sky-700 dark:text-sky-400",
    "bg-violet-500/15 text-violet-700 dark:text-violet-400",
    "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-400",
    "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400",
    "bg-lime-500/15 text-lime-700 dark:text-lime-400",
    "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
  ];

  const initials = $derived.by(() => {
    const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);

    return letters.toUpperCase();
  });

  const tone = $derived(tones[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % tones.length]);
</script>

<span
  class={[
    "inline-grid size-4.5 shrink-0 place-items-center rounded-sm font-mono text-[0.5625rem]/none font-bold tracking-tight",
    tone,
    className,
  ]}
  aria-hidden="true">{initials}</span
>
