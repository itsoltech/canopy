<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  let { state, class: className }: { state: string; class?: ClassValue } = $props();

  const label = $derived(
    state === "open"
      ? "Open"
      : state === "draft"
        ? "Draft"
        : state === "merged"
          ? "Merged"
          : state === "closed"
            ? "Closed"
            : "Unavailable",
  );
</script>

<span
  class={[
    "shrink-0 rounded-full px-2 py-0.5 font-medium",
    state === "merged"
      ? "bg-violet-500/10 text-violet-700 dark:text-violet-300"
      : state === "closed"
        ? "bg-red-500/10 text-red-700 dark:text-red-300"
        : state === "open"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300",
    className,
  ]}>{label}</span
>
