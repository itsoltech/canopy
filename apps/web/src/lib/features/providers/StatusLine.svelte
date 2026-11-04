<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import type { InstanceStatus } from "./instances.ts";

  /** An instance's status as a dot and its words (instances.ts `statusOn` / `statusAcross`); truncates in narrow rows. */
  let { status, class: className }: { status: InstanceStatus; class?: ClassValue } = $props();
</script>

<span class={["flex min-w-0 items-center gap-1.5", className]} title={status.label}
  ><StatusDot tone={status.tone} /><span class="truncate">{status.label}</span></span
>
