<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { projectMark, projectMarkColors } from "@canopy/ui/thread-row";

  /** Two-letter project mark with an optional custom color. Decorative. */
  let {
    name,
    color = "",
    class: className,
  }: { name: string; color?: string | undefined; class?: ClassValue } = $props();

  const mark = $derived(projectMark(name));
  const custom = $derived(projectMarkColors(color));

  // Literal utilities keep Tailwind's colour variables available after unused theme values are removed.
  const tones = {
    rose: "bg-rose-500/15 text-rose-800 dark:text-rose-400",
    amber: "bg-amber-500/15 text-amber-800 dark:text-amber-400",
    lime: "bg-lime-500/15 text-lime-800 dark:text-lime-400",
    teal: "bg-teal-500/15 text-teal-800 dark:text-teal-400",
    blue: "bg-blue-500/15 text-blue-800 dark:text-blue-400",
    violet: "bg-violet-500/15 text-violet-800 dark:text-violet-400",
    fuchsia: "bg-fuchsia-500/15 text-fuchsia-800 dark:text-fuchsia-400",
    zinc: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
  };
</script>

<span
  data-project-mark
  class={[
    "inline-grid size-4.5 shrink-0 place-items-center rounded-sm font-mono text-[0.5625rem]/none font-bold tracking-tight",
    !custom && tones[mark.tone],
    className,
  ]}
  style:background-color={custom?.fill}
  style:color={custom?.text}
  aria-hidden="true">{mark.initials}</span
>
