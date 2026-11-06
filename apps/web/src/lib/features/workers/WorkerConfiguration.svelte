<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import { configPending } from "#lib/features/overview/workers.ts";
  import WorkerInstanceBadge from "./WorkerInstanceBadge.svelte";
  import WorkerSection from "./WorkerSection.svelte";

  /**
   * What the gateway sent the worker: its provider instances (defined once, for every worker, in Settings → Providers)
   * and the configuration version it applied.
   */
  let { worker }: { worker: ui.Worker } = $props();
  const instances = $derived(worker.providerInstances.filter((i) => i.enabled));
</script>

<WorkerSection title="Configuration">
  {#snippet actions()}<ButtonLink size="sm" href="/settings/providers">Manage providers</ButtonLink>{/snippet}
  <dl class="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm/6 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-y-2">
    <dt class="font-medium text-zinc-700 dark:text-zinc-300">Providers</dt>
    <dd class="flex min-w-0 flex-wrap gap-1.5 max-sm:mb-2">
      {#each instances as instance (`${instance.harness}:${instance.id}`)}
        <WorkerInstanceBadge {instance} />
      {:else}<span class="text-zinc-500 dark:text-zinc-400">None</span>{/each}
    </dd>
    <dt class="font-medium text-zinc-700 dark:text-zinc-300">Version</dt>
    <dd class="text-zinc-600 tabular-nums dark:text-zinc-400">
      v{worker.appliedVersion}{#if configPending(worker)}<span class="text-amber-700 dark:text-amber-400">
          · v{worker.configVersion} pending</span
        >{/if}
    </dd>
  </dl>
  {#if worker.configIssues.length > 0}
    <Alert tone={worker.configIssues.some((i) => i.fatal) ? "error" : "warning"} title="Configuration issues">
      <ul role="list" class="grid gap-1">
        {#each worker.configIssues as issue (issue.path)}<li>
            <code class="font-mono">{issue.path}</code>: {issue.message}
          </li>{/each}
      </ul>
    </Alert>
  {/if}
</WorkerSection>
