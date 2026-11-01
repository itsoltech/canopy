<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { formatRelative } from "#lib/shared/format.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";
  import { configPending, osLabel, providerSummary } from "./workers.ts";

  /** A worker as a settings card: where it runs, what it can run, and whether its configuration applied. */
  let { worker }: { worker: ui.Worker } = $props();
  const where = $derived(
    [worker.hostname, osLabel(worker.os), worker.version && `v${worker.version}`, !worker.online && worker.lastSeenAt && `seen ${formatRelative(worker.lastSeenAt)}`]
      .filter(Boolean)
      .join(" · "),
  );
</script>

<SettingsGroup>
  <SettingsRow title={worker.name} description={where}>
    {#snippet leading()}<Icon name="computer-desktop" class="fill-zinc-400 dark:fill-zinc-500" />{/snippet}
    {#snippet control()}<StatusBadge status={worker.online ? "online" : "offline"} />{/snippet}
  </SettingsRow>
  <SettingsRow title="Directories" description="Workspaces must be inside these.">
    {#snippet control()}
      <div class="grid max-w-xs justify-items-end">
        {#each worker.allowedRoots as root (root)}<code class="max-w-full truncate font-mono text-[0.8125rem]/6 text-zinc-600 dark:text-zinc-400" title={root}>{root}</code>{:else}<span class="text-sm/6 text-zinc-500">None</span>{/each}
      </div>
    {/snippet}
  </SettingsRow>
  <SettingsRow title="Agents" description="Agent CLIs found on the machine.">
    {#snippet control()}
      <div class="flex flex-wrap justify-end gap-1.5">
        {#each worker.providers as provider (provider.provider)}<Badge tone={provider.available ? "emerald" : "neutral"}>{providerSummary(provider)}</Badge>{:else}<span class="text-sm/6 text-zinc-500">None</span>{/each}
      </div>
    {/snippet}
  </SettingsRow>
  <SettingsRow title="Profiles" description="How the agents reach their models.">
    {#snippet control()}
      <div class="flex flex-wrap justify-end gap-1.5">
        {#each worker.profiles as profile (profile.id)}<Badge tone={profile.available ? "neutral" : "rose"}>{profile.id}{profile.available ? "" : " (unavailable)"}</Badge>{:else}<span class="text-sm/6 text-zinc-500">None</span>{/each}
      </div>
    {/snippet}
  </SettingsRow>
  <SettingsRow title="Configuration" description="Sent by the gateway, applied by the worker.">
    {#snippet control()}
      <span class="text-sm/6 text-zinc-600 tabular-nums dark:text-zinc-400">
        v{worker.appliedVersion}{#if configPending(worker)}<span class="text-amber-700 dark:text-amber-400"> (v{worker.configVersion} pending)</span>{/if}
      </span>
    {/snippet}
  </SettingsRow>
  {#if worker.configIssues.length > 0}
    <div class="p-4">
      <Alert tone={worker.configIssues.some((i) => i.fatal) ? "error" : "warning"} title="Configuration issues">
        <ul role="list" class="grid gap-1">
          {#each worker.configIssues as issue (issue.path)}<li><code class="font-mono">{issue.path}</code>: {issue.message}</li>{/each}
        </ul>
      </Alert>
    </div>
  {/if}
</SettingsGroup>
