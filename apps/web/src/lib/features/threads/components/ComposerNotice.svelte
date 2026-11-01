<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** One line under a composer: why the message cannot go yet, or what will happen to it. Announced politely. */
  let { tone = "neutral", class: className, children }: { tone?: "neutral" | "warning"; class?: ClassValue; children: Snippet } = $props();
</script>

<p
  class={[
    "px-3 text-sm/5 text-pretty sm:text-xs/5",
    tone === "warning" ? "text-amber-700 dark:text-amber-400" : "text-zinc-600 dark:text-zinc-400",
    className,
  ]}
  role="status"
>
  {@render children()}
</p>
