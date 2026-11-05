<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** A provider instance's accent color as a dot (neutral without an accent). Decorative. */
  let { accent, class: className }: { accent: string; class?: ClassValue } = $props();
</script>

<span
  class={["shrink-0 rounded-full", !accent && "bg-zinc-400 dark:bg-zinc-500", className]}
  style:background-color={accent || undefined}
  aria-hidden="true"
></span>
