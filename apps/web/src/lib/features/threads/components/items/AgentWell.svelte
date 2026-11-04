<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** Recessed violet panel for agent-to-agent content (a task's prompt, a subagent's origin). */
  let { class: className, children }: { class?: ClassValue; children: Snippet } = $props();
</script>

<div
  class={[
    "rounded-lg bg-violet-50/60 p-3 ring-1 ring-violet-600/10 ring-inset dark:bg-violet-400/5 dark:ring-violet-400/15",
    className,
  ]}
>
  {@render children()}
</div>
