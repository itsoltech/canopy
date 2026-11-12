<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { projectMark } from "@canopy/ui/thread-row";

  /** Two-letter project mark with a colour derived from the name (stable across sessions). Decorative. */
  let { name, class: className }: { name: string; class?: ClassValue } = $props();

  const mark = $derived(projectMark(name));
  // Literal utilities keep Tailwind's colour variables available after unused theme values are removed.
  const tones = {
    emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    rose: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
    amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    sky: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
    violet: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
    fuchsia: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-400",
    cyan: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400",
    lime: "bg-lime-500/15 text-lime-700 dark:text-lime-400",
    zinc: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
  };
</script>

<span
  data-project-mark
  class={[
    "inline-grid size-4.5 shrink-0 place-items-center rounded-sm font-mono text-[0.5625rem]/none font-bold tracking-tight",
    tones[mark.tone],
    className,
  ]}
  aria-hidden="true">{mark.initials}</span
>
