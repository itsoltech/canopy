<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { scheduleStatusLook } from "./schedules.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";

  let { status, class: className }: { status: string; class?: ClassValue } = $props();
  const look = $derived(scheduleStatusLook(status));
</script>

<Badge tone={look.tone} compact class={className}>{look.label}</Badge>
