<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import type { LinkedWorker } from "./worker-records.svelte.ts";
  import { workerPresence } from "./worker-summary.ts";

  /** A worker's header badges: CLI updates it can install, then whether it is connected. */
  let { worker, linked }: { worker: ui.Worker; linked?: LinkedWorker | undefined } = $props();

  const updates = $derived(worker.cliTools.filter((t) => t.action === "update").length);
  const presence = $derived(workerPresence(worker, linked));
</script>

<div class="flex shrink-0 flex-wrap items-center gap-1.5">
  {#if updates > 0}<Badge tone="amber">{updates === 1 ? "1 update" : `${updates} updates`}</Badge>{/if}
  <Badge tone={presence.tone}>{presence.label}</Badge>
</div>
