<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { dateLineLabel, fullDateLabel } from "../chat-timeline.ts";

  /** Centered time between messages: "Today 8:44 PM". */
  let { at, class: className }: { at: Date; class?: ClassValue } = $props();
</script>

<p class={["text-center text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", className]}>
  <time datetime={at.toISOString()} title={fullDateLabel(at)}>{dateLineLabel(at, clock.now)}</time>
</p>
