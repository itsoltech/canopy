<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { formatCount } from "#lib/shared/format.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { habitSuggestionCount } from "./habits-format.ts";

  let { count, class: className }: { count: number; class?: ClassValue } = $props();
</script>

<span class={["inline-flex shrink-0 items-center", className]}>
  <span aria-hidden="true"><Badge compact tone="amber">{formatCount(count)}</Badge></span>
  <span class="sr-only">{habitSuggestionCount(count)}</span>
</span>
