<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import AccountStatusRow, { hasAccountStatus } from "#lib/features/providers/AccountStatusRow.svelte";
  import { providerLabel } from "#lib/features/threads/labels.ts";
  import WorkerSection from "./WorkerSection.svelte";

  /** Who each provider instance is signed in as on this worker; nothing when no instance can tell. */
  let { worker, online }: { worker: ui.Worker; online: boolean } = $props();
  const accounts = $derived(worker.providerInstances.filter((i) => i.enabled && hasAccountStatus(i.account)));
</script>

{#if accounts.length}
  <WorkerSection title="Provider accounts">
    {#each accounts as instance (`${instance.harness}/${instance.id}`)}
      <div class="grid min-w-0 gap-1">
        <p class="text-sm/6 font-medium text-zinc-700 dark:text-zinc-300">
          {instance.label || providerLabel(instance.harness)} · {instance.id}
        </p>
        <AccountStatusRow
          account={instance.account}
          workerId={worker.id}
          harness={instance.harness}
          id={instance.id}
          {online}
          os={worker.os}
        />
      </div>
    {/each}
  </WorkerSection>
{/if}
