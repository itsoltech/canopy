<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import ReleaseChannelField from "./ReleaseChannelField.svelte";
  import WorkerUpdateRow from "./WorkerUpdateRow.svelte";
  import { UpdatesState, updateBusy, updateStateLabel } from "./updates.svelte.ts";

  let { class: className }: { class?: ClassValue } = $props();
  const updates = new UpdatesState();
  const snapshot = $derived(updates.snapshot);
  const busy = $derived(updateBusy(snapshot?.gatewayState ?? ""));

  onMount(() => {
    void updates.reload();
    const timer = setInterval(() => void updates.reload(), 5000);

    return () => clearInterval(timer);
  });
</script>

<SettingsGroup
  title="Updates"
  description="Update the gateway first. Workers follow its version when their active work finishes."
  class={className}
>
  <div class="grid gap-5 p-4 sm:p-5">
    {#if updates.error}<Alert tone="error"
        >{updates.error}{#snippet actions()}<Button size="sm" onclick={() => void updates.reload()}>Retry</Button
          >{/snippet}</Alert
      >{/if}
    {#if snapshot}
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0 space-y-1">
          <p class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">
            Gateway <span class="font-mono tabular-nums">{snapshot.gatewayVersion}</span>
          </p>
          <div class="flex flex-wrap items-center gap-2 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
            <Badge tone={snapshot.gatewayState === "failed" ? "rose" : busy ? "amber" : "neutral"}
              >{busy
                ? updateStateLabel(snapshot.gatewayState, true)
                : snapshot.gatewayInstallKind === "binary"
                  ? "Binary install"
                  : "Managed externally"}</Badge
            >
            <p>{snapshot.availableVersion ? `Available: ${snapshot.availableVersion}` : "No release found yet"}</p>
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            size="sm"
            loading={updates.pending === "check" || snapshot.checking}
            disabled={!snapshot.admin || !!updates.pending}
            onclick={() => void updates.manage({ action: "check" })}>Check for updates</Button
          >
          {#if snapshot.gatewayInstallKind === "binary" && snapshot.admin}
            <Button
              size="sm"
              loading={busy}
              disabled={!!updates.pending ||
                !snapshot.availableVersion ||
                snapshot.availableVersion === snapshot.gatewayVersion}
              onclick={() => void updates.manage({ action: "gateway" })}>Update gateway</Button
            >
          {/if}
        </div>
      </div>
      {#if snapshot.gatewayReason}<p
          class="text-base/6 text-pretty break-words text-zinc-500 sm:text-sm/6 dark:text-zinc-400"
          role="status"
        >
          {snapshot.gatewayReason}
        </p>{/if}
      <ReleaseChannelField
        current={snapshot.channel}
        version={snapshot.gatewayVersion}
        disabled={!snapshot.admin || !!updates.pending || busy}
        pending={updates.pending === "channel"}
        onsave={(channel) => void updates.manage({ action: "channel", channel })}
      />
      <div class="border-t border-zinc-950/5 pt-4 dark:border-white/10">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h3 class="text-base font-medium text-zinc-950 sm:text-sm dark:text-white">Worker versions</h3>
          <div>
            <Button
              size="sm"
              disabled={!snapshot.admin ||
                !!updates.pending ||
                !snapshot.workers.some(
                  (w) =>
                    w.installKind === "binary" &&
                    w.version !== snapshot.gatewayVersion &&
                    w.state !== "ahead" &&
                    !updateBusy(w.state),
                )}
              loading={updates.pending === "all"}
              onclick={() => void updates.manage({ action: "all" })}>Update all</Button
            >
          </div>
        </div>
        <div class="divide-y divide-zinc-950/5 dark:divide-white/10">
          {#each snapshot.workers as worker (worker.workerId)}
            <WorkerUpdateRow
              {worker}
              gatewayVersion={snapshot.gatewayVersion}
              admin={snapshot.admin}
              pending={updates.pending}
              onupdate={() => void updates.manage({ action: "worker", workerId: worker.workerId })}
              class="py-4 last:pb-0"
            />
          {:else}<p class="py-4 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
              Enrolled workers will appear here with their version and compatibility.
            </p>{/each}
        </div>
      </div>
    {:else}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400" role="status">
        Loading update status…
      </p>{/if}
  </div>
</SettingsGroup>
