<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { scheduleStatusLook } from "./schedules.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";

  let { status, class: className }: { status: string; class?: ClassValue } = $props();
  const look = $derived(scheduleStatusLook(status));
</script>

<div
  class={["flex shrink-0 items-center gap-1.5 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400", className]}
>
  <StatusDot tone={look.tone} />
  <span>{look.label}</span>
</div>
