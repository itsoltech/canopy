<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import type { InstanceStatus } from "./instances.ts";

  let {
    status,
    wrap = false,
    class: className,
  }: { status: InstanceStatus; wrap?: boolean; class?: ClassValue } = $props();
</script>

<span class={["flex min-w-0 gap-1.5", wrap ? "items-start" : "items-center", className]} title={status.label}>
  <StatusDot tone={status.tone} class={wrap ? "mt-[calc((1lh-var(--spacing)*1.5)/2)]" : undefined} />
  <span class={wrap ? "wrap-anywhere" : "truncate"}>{status.label}</span>
</span>
