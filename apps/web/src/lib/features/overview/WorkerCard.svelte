<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { formatRelative } from "#lib/shared/format.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Card from "#lib/shared/ui/Card.svelte";
  import MetaList from "#lib/shared/ui/MetaList.svelte";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";
  import { configPending, osLabel, providerSummary } from "./workers.ts";

  /** A worker: where it runs, what it can run and whether its configuration applied. */
  let { worker }: { worker: ui.Worker } = $props();
</script>

<Card as="article" class="p-4 sm:p-5" aria-label="Worker {worker.name}">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h3 class="truncate text-base/6 font-semibold">{worker.name}</h3>
      <MetaList class="mt-0.5">
        {#if worker.hostname}<span class="truncate">{worker.hostname}</span>{/if}
        <span>{osLabel(worker.os)}</span>
        {#if worker.version}<span>v{worker.version}</span>{/if}
        {#if !worker.online && worker.lastSeenAt}<span>Seen {formatRelative(worker.lastSeenAt)}</span>{/if}
      </MetaList>
    </div>
    <StatusBadge status={worker.online ? "online" : "offline"} />
  </div>

  <dl class="mt-4 grid gap-3 border-t border-zinc-950/5 pt-4 text-base/6 sm:text-sm/6 dark:border-white/5">
    <div class="grid gap-1 sm:grid-cols-[8rem_1fr] sm:gap-3">
      <dt class="font-medium text-zinc-950 dark:text-white">Directories</dt>
      <dd class="min-w-0 text-zinc-600 dark:text-zinc-400">
        {#each worker.allowedRoots as root (root)}
          <code class="block truncate font-mono text-sm/6 sm:text-[0.8125rem]/6" title={root}>{root}</code>
        {:else}
          None allowed
        {/each}
      </dd>
    </div>
    <div class="grid gap-1 sm:grid-cols-[8rem_1fr] sm:gap-3">
      <dt class="font-medium text-zinc-950 dark:text-white">Agents</dt>
      <dd class="flex flex-wrap gap-1.5">
        {#each worker.providers as provider (provider.provider)}
          <Badge tone={provider.available ? "emerald" : "neutral"}>{providerSummary(provider)}</Badge>
        {:else}
          <span class="text-zinc-600 dark:text-zinc-400">None detected</span>
        {/each}
      </dd>
    </div>
    <div class="grid gap-1 sm:grid-cols-[8rem_1fr] sm:gap-3">
      <dt class="font-medium text-zinc-950 dark:text-white">Profiles</dt>
      <dd class="flex flex-wrap gap-1.5">
        {#each worker.profiles as profile (profile.id)}
          <Badge tone={profile.available ? "neutral" : "rose"}>{profile.id}{profile.available ? "" : " (unavailable)"}</Badge>
        {:else}
          <span class="text-zinc-600 dark:text-zinc-400">None</span>
        {/each}
      </dd>
    </div>
    <div class="grid gap-1 sm:grid-cols-[8rem_1fr] sm:gap-3">
      <dt class="font-medium text-zinc-950 dark:text-white">Configuration</dt>
      <dd class="text-zinc-600 tabular-nums dark:text-zinc-400">
        v{worker.appliedVersion}{#if configPending(worker)}<span class="text-amber-700 dark:text-amber-400"> (v{worker.configVersion} pending)</span>{/if}
      </dd>
    </div>
  </dl>

  {#if worker.configIssues.length > 0}
    <Alert tone={worker.configIssues.some((i) => i.fatal) ? "error" : "warning"} title="Configuration issues" class="mt-4">
      <ul role="list" class="grid gap-1">
        {#each worker.configIssues as issue (issue.path)}
          <li><code class="font-mono">{issue.path}</code>: {issue.message}</li>
        {/each}
      </ul>
    </Alert>
  {/if}
</Card>
